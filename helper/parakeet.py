#!/usr/bin/python3 -I
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2025-2026 The Dictator authors (see AUTHORS)
"""Offline speech-to-text: NVIDIA Parakeet TDT 0.6B v3 (ONNX on the CPU, nothing leaves the laptop).

Languages: the model knows 25 European languages and picks the language itself. Only the languages
you turned on are allowed: every word piece (token) of the vocabulary that holds a letter outside
their alphabets is forbidden while decoding (so no Polish l-with-stroke or Greek appears in Ukrainian).
  auto  the letters of all enabled languages. Cyrillic languages share most letters, so when more
        than one of Ukrainian / Russian / Bulgarian is enabled, the audio is decoded once per
        Cyrillic language from the same encoder output (the encoder is ~95% of the work), each time
        with that language's letters plus the other enabled scripts; the main (first enabled) one
        wins unless another is clearly surer (MARGIN, log-probability per audio second).
  <code>  that language only
Plain Latin a-z is always allowed (names, brands and English words appear in every language).
Long audio is cut at the quietest spot into pieces of at most CHUNK_S (memory grows with length^2).

Use:
  parakeet.py MODEL_DIR [--lang auto|uk|..] [--langs uk,en,ru] [--threads N] [--fp32] WAV...
        one JSON line per file
  parakeet.py --worker MODEL_DIR [--threads N] [--fp32]   for the dictation helper: loads the model,
        prints {"ready": true, "load_s": ...}, then per request reads one JSON line
        {"n": BYTES, "lang": "auto"|code, "langs": [codes, main first], "margin": float, "gate_db": float}
        followed by BYTES of raw 16 kHz mono s16 audio, and answers one JSON line
        {"text", "lang", "asr_s", "note"} or {"error"}. Ends at end of input.
        lang "pieces" (one piece of a recording that the helper transcribes while you speak, see
        Streamer in helper/dictate): no choice here, it answers {"cands": {code: [text, score]},
        "main": code, "asr_s", "note"}, one candidate per enabled Cyrillic language (or one "auto" if
        fewer than two are on); the helper picks the language once, over all pieces of the recording.
  parakeet.py --quantize DIR   makes DIR/*.int8.onnx from the fp32 files in DIR (8-bit integers, per
        channel, MatMul layers only; needs the onnx package too) and prints {"ok": true} or {"error"}
"""
import json
import os
import sys
import time
import wave

try:
    if sys.argv[1:2] == ["--quantize"]:
        import onnx.reference  # noqa: F401  (Fedora's onnx and onnxruntime clash unless this comes first)
    import numpy as np
    import onnxruntime as ort
except ImportError as e:              # no runtime on this system: the caller falls back to the container
    print(json.dumps({"error": f"no-runtime: {e}"}), flush=True)
    sys.exit(3)

SR = 16000
DURATIONS = [0, 1, 2, 3, 4]           # TDT duration classes of this model
MAX_SYMBOLS_PER_STEP = 10
CHUNK_S = 120.0
# CPU threads: the number of REAL cores to use (hyper-threads do not help: on a 4-core i7, 8 threads
# were slower than 4). Default: half the logical CPUs, at most 4. Override: PARAKEET_THREADS.
THREADS = int(os.environ.get("PARAKEET_THREADS") or max(1, min(4, (os.cpu_count() or 2) // 2)))
# auto mode: another Cyrillic language must be this much surer than the main one (log-probability
# per audio second). Ukrainian speech measured -0.17..-0.41 against Russian; tune with the log numbers.
MARGIN = float(os.environ.get("PARAKEET_RU_MARGIN") or 0.15)

LAT = set("abcdefghijklmnopqrstuvwxyz")
# the model's 25 languages: letters beyond a-z (Latin script), or the whole alphabet (Cyrillic, Greek)
LATIN_EXTRA = {
    "en": "", "de": "äöüß", "fr": "àâæçéèêëîïôœùûüÿ", "es": "áéíñóúü", "it": "àèéìíîòóùú",
    "pt": "áâãàçéêíóôõú", "nl": "áéëíïóöúü", "da": "æøå", "sv": "åäö", "fi": "äöåšž",
    "pl": "ąćęłńóśźż", "cs": "áčďéěíňóřšťúůýž", "sk": "áäčďéíĺľňóôŕšťúýž", "sl": "čšž",
    "hr": "čćđšž", "hu": "áéíóöőúüű", "ro": "ăâîșțşţ", "lv": "āčēģīķļņšūž", "lt": "ąčęėįšųūž",
    "et": "äöõüšž", "mt": "àèìòùċġħż",
}
CYRILLIC = {"uk": "абвгґдеєжзиіїйклмнопрстуфхцчшщьюя", "ru": "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
            "bg": "абвгдежзийклмнопрстуфхцчшщъьюя"}
GREEK = {"el": "αβγδεζηθικλμνξοπρσςτυφχψωάέήίόύώϊϋΐΰ"}
LANGS = list(LATIN_EXTRA) + list(CYRILLIC) + list(GREEK)
DEFAULT_LANGS = ["uk", "en", "ru"]
MARKS = {"es": set("¿¡")}             # punctuation only one language uses: allowed only with it


def letters(code):
    if code in LATIN_EXTRA:
        return LAT | set(LATIN_EXTRA[code])
    return set(CYRILLIC.get(code) or GREEK[code])


def allowed(langs):
    """(letters, marks) allowed when these languages are on. Without any Latin-script language plain
    a-z stays allowed anyway: names, brands and English words appear in every language."""
    lets, marks = set(LAT), set()
    for c in langs:
        lets |= letters(c)
        marks |= MARKS.get(c, set())
    return lets, marks


def check_langs(langs):
    langs = [c for c in dict.fromkeys(langs or DEFAULT_LANGS)]
    if not langs or any(c not in LANGS for c in langs):
        raise ValueError("langs")
    return langs


class Parakeet:
    def __init__(self, model_dir, fp32=False, threads=THREADS):
        t0 = time.monotonic()
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.log_severity_level = 3
        p = ["CPUExecutionProvider"]
        sfx = ".onnx" if fp32 else ".int8.onnx"
        self.pre = ort.InferenceSession(os.path.join(model_dir, "nemo128.onnx"), so, providers=p)
        self.enc = ort.InferenceSession(os.path.join(model_dir, "encoder-model" + sfx), so, providers=p)
        self.dec = ort.InferenceSession(os.path.join(model_dir, "decoder_joint-model" + sfx), so, providers=p)
        vocab = {}
        with open(os.path.join(model_dir, "vocab.txt"), encoding="utf-8") as f:
            for line in f:
                tok, idx = line.rstrip("\n").rsplit(" ", 1)
                vocab[int(idx)] = tok
        self.nvocab = max(vocab) + 1
        self.vocab = [vocab.get(i, "<unk>") for i in range(self.nvocab)]
        self.blank = self.vocab.index("<blk>")
        # per token: the letters and the one-language marks it holds (to build masks for any language set)
        all_marks = set().union(*MARKS.values())
        self.tok_chars = []
        for i, t in enumerate(self.vocab):
            if i == self.blank:
                self.tok_chars.append((frozenset(), frozenset()))
            elif t.startswith("<"):
                self.tok_chars.append(None)                      # special tokens: never
            else:
                low = t.lower().replace("▁", "")
                self.tok_chars.append((frozenset(ch for ch in low if ch.isalpha()),
                                       frozenset(ch for ch in low if ch in all_marks)))
        self._masks = {}
        st = {i.name: i.shape for i in self.dec.get_inputs()}
        self.state_shapes = [[1 if not isinstance(d, int) else d for d in st[n]]
                             for n in ("input_states_1", "input_states_2")]
        self.load_s = time.monotonic() - t0

    def mask(self, lets, marks):
        key = (frozenset(lets), frozenset(marks))
        m = self._masks.get(key)
        if m is None:
            m = np.full(self.nvocab, -np.inf, np.float32)
            for i, tc in enumerate(self.tok_chars):
                if tc is not None and tc[0] <= key[0] and tc[1] <= key[1]:
                    m[i] = 0
            self._masks[key] = m
        return m

    # -- decoding
    def _decode(self, enc, enc_len, mask):
        """Greedy TDT decoding of one encoder output [D, T]; returns (tokens, log-prob sum)."""
        s1, s2 = (np.zeros(s, np.float32) for s in self.state_shapes)
        tokens, t, emitted, prev, score = [], 0, 0, self.blank, 0.0
        while t < enc_len:
            out, n1, n2 = self.dec.run(
                ["outputs", "output_states_1", "output_states_2"],
                {"encoder_outputs": enc[None, :, t:t + 1],
                 "targets": np.array([[prev]], np.int32),
                 "target_length": np.array([1], np.int32),
                 "input_states_1": s1, "input_states_2": s2})
            out = out.reshape(-1)
            logits = out[:self.nvocab] + mask
            tok = int(np.argmax(logits))
            mx = logits[tok]
            score += float(-np.log(np.sum(np.exp(logits - mx))))   # log-softmax of the chosen token
            step = DURATIONS[int(np.argmax(out[self.nvocab:]))]
            if tok != self.blank:
                s1, s2, prev = n1, n2, tok
                tokens.append(tok)
                emitted += 1
            if step > 0:
                t += step
                emitted = 0
            elif tok == self.blank or emitted >= MAX_SYMBOLS_PER_STEP:
                t += 1
                emitted = 0
        return tokens, score

    def _text(self, tokens):
        s = "".join(self.vocab[t] for t in tokens)
        return " ".join(s.replace("▁", " ").split())

    def _encode(self, audio):
        x = audio.astype(np.float32)[None, :]
        feats, flen = self.pre.run(None, {"waveforms": x, "waveforms_lens": np.array([x.shape[1]], np.int64)})
        enc, elen = self.enc.run(None, {"audio_signal": feats, "length": flen})
        return enc[0], int(elen[0])

    def _run(self, encs, mask):
        """Decode the encoded pieces of one audio with a token mask: (text, log-probability sum)."""
        texts, score = [], 0.0
        for e, n in encs:
            tk, sc = self._decode(e, n, mask)
            texts.append(self._text(tk))
            score += sc
        return " ".join(filter(None, texts)), score

    def candidates(self, audio, langs=None):
        """Every candidate language's (text, score) from one encoder pass, and the main one. One
        candidate per enabled Cyrillic language (they share most letters, so the mask alone cannot
        tell them apart), or a single "auto" with the letters of all enabled languages."""
        langs = check_langs(langs)
        encs = [self._encode(a) for a in split_long(audio)]
        cyr = [c for c in langs if c in CYRILLIC]
        if len(cyr) < 2:
            return {"auto": self._run(encs, self.mask(*allowed(langs)))}, "auto"
        others = [c for c in langs if c not in CYRILLIC]
        return {c: self._run(encs, self.mask(*allowed([c] + others))) for c in cyr}, cyr[0]

    def transcribe(self, audio, lang="auto", langs=None, margin=MARGIN):
        """audio: float32 [-1, 1] at 16 kHz; langs: enabled languages, main first.
        Returns (text, chosen language, note for the log)."""
        langs = check_langs(langs)
        if lang != "auto":
            if lang not in LANGS:
                raise ValueError("lang")
            encs = [self._encode(a) for a in split_long(audio)]
            return self._run(encs, self.mask(*allowed([lang])))[0], lang, f"lang {lang} (chosen)"
        res, main = self.candidates(audio, langs)
        if main == "auto":
            return res[main][0], "auto", f"langs {'+'.join(langs)}"
        if len({t for t, _ in res.values()}) == 1:   # no letter where they differ (Latin, numbers...)
            return res[main][0], "auto", "lang same"
        best = max(res, key=lambda c: res[c][1])
        diff = (res[best][1] - res[main][1]) / max(len(audio) / SR, 0.1)
        pick = best if diff > margin else main
        return res[pick][0], pick, f"lang {pick} ({best}-{main} {diff:+.3f}/s)"


def gate(a, drop_db):
    """Mute what is much quieter than the speaker: other people in the room, a TV. The speaker's level
    is the 95th percentile of 50 ms frames; frames more than drop_db below it (or loud for less than
    100 ms) are silenced (only turning
    them down is not enough: the model normalises loudness and still hears them), keeping 150 ms around
    every loud frame (word edges), with 10 ms ramps (no clicks).
    Returns (audio, share of the time muted)."""
    if drop_db <= 0 or len(a) < SR // 2:
        return a, 0.0
    hop = SR // 20
    n = len(a) // hop
    frames = a[:n * hop].reshape(n, hop)
    db = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-10)
    loud = db > np.percentile(db, 95) - drop_db
    # a lone loud frame is a peak of a far voice, not your speech: at least 100 ms in a row count
    loud = loud & (np.roll(loud, 1) | np.roll(loud, -1))
    keep = np.convolve(loud.astype(np.float32), np.ones(7, np.float32), "same") > 0    # +-150 ms
    gain = keep.astype(np.float32)
    g = np.repeat(gain, hop)
    g = np.concatenate([g, np.full(len(a) - len(g), gain[-1], np.float32)])
    ramp = SR // 100
    g = np.convolve(g, np.ones(ramp, np.float32) / ramp, "same")
    return (a * g).astype(np.float32), float(1 - keep.mean())


def split_long(a):
    """Cut audio longer than CHUNK_S at the quietest 0.2 s inside the last 20 s of each piece."""
    n = int(CHUNK_S * SR)
    out = []
    while len(a) > n:
        lo, win = n - 20 * SR, int(0.2 * SR)
        e = np.convolve(a[lo:n].astype(np.float32) ** 2, np.ones(win, np.float32), "valid")
        cut = lo + int(np.argmin(e)) + win // 2
        out.append(a[:cut])
        a = a[cut:]
    out.append(a)
    return out


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getframerate() != SR or w.getsampwidth() != 2:
            raise SystemExit(f"{path}: need 16 kHz 16-bit wav")
        raw = np.frombuffer(w.readframes(w.getnframes()), np.int16)
        if w.getnchannels() > 1:
            raw = raw.reshape(-1, w.getnchannels()).mean(axis=1)
    return raw.astype(np.float32) / 32768.0


def read_exact(f, n):
    buf = bytearray()
    while len(buf) < n:
        b = f.read(n - len(buf))
        if not b:
            raise EOFError
        buf += b
    return bytes(buf)


def worker(model_dir, threads=THREADS, fp32=False):
    m = Parakeet(model_dir, fp32=fp32, threads=threads)
    out = sys.stdout
    out.write(json.dumps({"ready": True, "load_s": round(m.load_s, 2)}) + "\n")
    out.flush()
    inp = sys.stdin.buffer
    while True:
        line = inp.readline()
        if not line:
            return
        try:
            req = json.loads(line)
            n = int(req["n"])
            if n < 0 or n > 2 * SR * 3600 or n % 2:
                raise ValueError("size")
            raw = read_exact(inp, n)
        except EOFError:
            return
        except (ValueError, KeyError, TypeError) as e:
            out.write(json.dumps({"error": f"bad request: {e}"}) + "\n")
            out.flush()
            return
        try:
            t0 = time.monotonic()
            audio = np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0
            audio, muted = gate(audio, float(req.get("gate_db") or 0))
            if req.get("lang") == "pieces":
                cands, main = m.candidates(audio, req.get("langs"))
                res = {"cands": cands, "main": main, "note": ""}
            else:
                text, lang, note = m.transcribe(audio, req.get("lang") or "auto", req.get("langs"),
                                                float(req.get("margin", MARGIN)))
                res = {"text": text, "lang": lang, "note": note}
            if muted:
                res["note"] += f", quieter voices muted {100 * muted:.0f}%"
            res["asr_s"] = round(time.monotonic() - t0, 2)
        except Exception as e:
            res = {"error": f"{type(e).__name__}: {e}"}
        out.write(json.dumps(res, ensure_ascii=False) + "\n")
        out.flush()


def quantize(model_dir):
    """The int8 files from the fp32 ones. On 2.5 min of Ukrainian speech, text from these differed from
    fp32 in 7% of words; from the int8 files published with the ONNX conversion, in 30%."""
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic
        for name in ("encoder-model", "decoder_joint-model"):
            quantize_dynamic(os.path.join(model_dir, name + ".onnx"), os.path.join(model_dir, name + ".int8.onnx"),
                             per_channel=True, weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
        res = {"ok": True}
    except Exception as e:
        res = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(res), flush=True)


def main():
    args = sys.argv[1:]
    if args[:1] == ["--quantize"]:
        return quantize(args[1])
    if args[:1] == ["--worker"]:
        threads = int(args[args.index("--threads") + 1]) if "--threads" in args else THREADS
        return worker(args[1], threads if threads > 0 else THREADS, "--fp32" in args)
    opts = {"--lang": "auto", "--threads": str(THREADS), "--langs": ",".join(DEFAULT_LANGS)}
    files = []
    i = 0
    while i < len(args):
        if args[i] in opts:
            opts[args[i]] = args[i + 1]
            i += 2
            continue
        files.append(args[i])
        i += 1
    model_dir = files.pop(0)
    m = Parakeet(model_dir, fp32="--fp32" in files, threads=int(opts["--threads"]))
    for f in [x for x in files if not x.startswith("--")]:
        a = read_wav(f)
        t0 = time.monotonic()
        text, lang, note = m.transcribe(a, opts["--lang"], opts["--langs"].split(","))
        dt = time.monotonic() - t0
        print(json.dumps({"file": os.path.basename(f), "text": text, "lang": lang, "note": note,
                          "audio_s": round(len(a) / SR, 2), "load_s": round(m.load_s, 2),
                          "asr_s": round(dt, 2)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
