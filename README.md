# Dictator: offline voice dictation for GNOME

Press **Ctrl+Alt+Space**, speak, then press **Enter**. The text is typed where your cursor was: a
messenger, a browser, an editor or a terminal. Speech recognition runs on your computer, with no
account, no API key and no cloud.

- **Private.** Audio stays in memory and never leaves the machine. The speech model runs in a sandbox
  with no network access. Text is typed through GNOME's input method, not pasted through the
  clipboard.
- **25 European languages.** Turn on the ones you speak, and mix them freely: English words inside
  Ukrainian stay English. The model is
  [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).
- **Works on a plain CPU.** The text is ready about a second after you stop talking, even after
  minutes of dictation: the recording is transcribed in pieces while you speak.
- **Native look.** A small libadwaita-style pill shows your voice level. The top-bar icon has a menu
  with your last texts.

## Install

You need two parts: the GNOME extension, and the **helper program** that records the microphone and
runs the speech model. The extension cannot include the helper (extensions.gnome.org does not allow
executables in extensions), so the helper is installed from this repository:

```sh
git clone https://github.com/kcharukovskyi/dictator.git
cd dictator
./install.sh                  # or ./install.sh --no-extension if you got the extension from extensions.gnome.org
```

Then log out and log in once.

`install.sh` installs into your home folder only and never asks for sudo. It does the following:

1. Checks for `pw-record` and `pactl`. If one is missing, it prints the install command for your
   distribution.
2. Picks where the model runs:
   - the system packages `python3-onnxruntime`, `python3-numpy` and `python3-onnx`, sandboxed with
     bubblewrap, or
   - if those are missing, a podman or docker image that it builds on your computer from signed
     Fedora packages ([`helper/Containerfile`](helper/Containerfile)).
3. Installs the helper into `~/.local/bin/dictate` and the extension.
4. Offers to download the speech model (see below). You can also do this later in the settings
   window.
5. Runs a self-test. It checks that the model works and that its sandbox has no network.

**Requirements:** GNOME 51 on Wayland, PipeWire, a 64-bit CPU (4+ cores recommended), about 1.5 GB of
free memory while dictating, and 1 GB of disk for the model.

## The speech model

Open **microphone menu → Settings → Speech → Speech Model** and pick one of two variants:

| Variant | Download | On disk | Notes |
|---|---|---|---|
| **Standard** (8-bit) | 2.5 GB | 0.9 GB | Recommended. Fast, needs little memory. |
| **Full Precision** (32-bit) | 2.5 GB | 2.5 GB | Slightly more accurate, about half as fast, needs ~3 GB of memory. |

Where the files come from:

- **Source.** The files are NVIDIA's model in the ONNX format, made by the
  [onnx-asr](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) project. They are downloaded
  from Hugging Face at a fixed revision.
- **Check.** Every file is checked against its SHA-256 before it is used. The hashes are listed in
  [`helper/dictate`](helper/dictate).
- **Network.** The download is the only time Dictator uses the network, and it happens only when you
  ask for it.
- **The Standard variant is made on your computer.** Dictator converts the downloaded files to 8-bit
  with ONNX Runtime and then deletes the 32-bit ones. The conversion is reproducible: with ONNX
  Runtime 1.22 the result is byte-for-byte identical to the reference build.
- **Why not a ready-made 8-bit download.** The onnx-asr repository also has 8-bit files, which are
  smaller. On a small test (2.5 minutes of Ukrainian speech, one speaker), their text differed from
  the 32-bit model in 30% of the words. Dictator's own conversion differed in 7%.

The same can be done in a terminal: `dictate --download int8` (or `fp32`), `dictate --remove fp32`,
`dictate --models`.

## Use

| Keys | Action |
|---|---|
| **Ctrl+Alt+Space** | Start recording |
| **Enter** (while recording) | Finish. The text is typed in; the Enter key does not reach the app. Can be another key, Shift+Caps Lock, or the start shortcut again |
| **Caps Lock** (while recording) | Pause / resume. Caps Lock itself is not toggled |
| **Esc** (while recording) | Cancel |

You can change every key in Settings, and changes apply at once. Settings refuses shortcuts that
GNOME already owns (for example, Super+Space switches the input source).

- The text goes to the window where you **started** recording, even if you switched away meanwhile.
- Drag the recording indicator with the mouse to move it; it stays there. A double-click puts it back.
- Long dictation: while you speak, the recording is cut at your pauses into pieces of 10 to 30
  seconds, and each piece is transcribed in the background. Pieces of that length also give better
  text than one long piece, which can drop whole phrases. Stretches with no voice are skipped, so
  the model cannot invent words from noise.
- Some apps don't accept typed text (some X11 and Electron apps). For them, the text waits in the
  top-bar menu, where one click copies it. If you allow it in Settings, Dictator pastes the text
  through the clipboard instead, then puts back what the clipboard held before.
- If the screen locks while you record, the recording is finished and transcribed. Nothing is typed on
  the lock screen; the text waits in the menu.
- Speech settings:
  - Spoken punctuation: say "кома", "comma" or "new line".
  - Removal of hesitation sounds.
  - Word replacements and snippets ("мій імейл = me@example.com").
  - Stop on silence.
  - Choice of microphone.
  - Muting of quieter voices around you.

## Privacy

- Recordings are kept in `$XDG_RUNTIME_DIR` (RAM) only until they are transcribed. A failed recording
  stays there so that you can retry it from the menu. All recordings are deleted after the time set in
  Settings (1 hour by default).
- The menu keeps your last three texts in RAM. You can turn this off.
- Only if you turn on **Keep Audio to Transcribe Again** (Settings, Privacy), their recordings stay in
  RAM too, for the same time, so the menu can transcribe a text again: as it was, or in one of the
  languages you choose there. Off by default; turning it off deletes the kept audio.
- The log (`~/.cache/dictate/dictate.log`) contains timings and numbers, never your text.
- No telemetry.

## Uninstall

```sh
./uninstall.sh          # keeps the model and your settings
./uninstall.sh --all    # removes everything
```

## Project layout

| Path | What |
|---|---|
| `extension/` | The GNOME Shell extension (GJS). `scripts/pack.sh` builds the zip for extensions.gnome.org |
| `helper/dictate` | The helper: recording, model download, transcription (Python, standard library only) |
| `helper/parakeet.py` | The speech model runner (ONNX Runtime + NumPy), always run in the sandbox |
| `helper/Containerfile` | The optional local container image for the model |
| `docs/REVIEW-NOTES.md` | Notes for extensions.gnome.org reviewers |

## License

Dictator is made by [kcharukovskyi](https://github.com/kcharukovskyi) and [Yegor Isakov](https://isakov.fyi)
([@yegqr](https://github.com/yegqr)). It is licensed GPL-3.0-or-later (see [LICENSE](LICENSE) and
[AUTHORS](AUTHORS)). The speech
model is NVIDIA's and licensed CC BY 4.0. Dictator writes its attribution to `NOTICE.txt` in the model
folder.

NVIDIA and Parakeet are names of NVIDIA Corporation, used only to identify the model. Dictator is not
affiliated with or endorsed by NVIDIA, and is an independent extension for GNOME.
