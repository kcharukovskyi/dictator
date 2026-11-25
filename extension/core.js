// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2025-2026 The Dictator authors (see AUTHORS)
// The dictation itself: the helper process, the keys while recording, putting the text into the app,
// the pill on screen and the top-bar menu.
//
// A recording: the start shortcut runs the helper (~/.local/bin/dictate, see helper/dictate in the
// project), which records and prints the voice level, then the text. The text goes to the window that
// had the focus when the recording started: it is typed in through the input method (like the
// on-screen keyboard), never into another window and never on the lock screen. An app that takes no
// typed text gets a Ctrl+V paste through the clipboard only if the user allowed it in Settings;
// otherwise the text waits in the top-bar menu.
// While recording, Caps Lock pauses (by default): the lock itself is put back as it was.
// The pill can be dragged with the mouse; it stays where you put it (double-click: back to its place).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {readKeys, readPrivacy, readSpeech, readPillSpot, writePillSpot, againLanguages, cleanText, CAPS, NONE, SAME,
    SHIFT_CAPS, NEWLINE_MARK, LANGUAGES} from './keys.js';

const HELPER = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'dictate']);
const PENDING_DIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'dictate']);
const HISTORY_DIR = `${PENDING_DIR}-history`;
const BADGE_ICON = {rec: 'audio-input-microphone-symbolic', pause: 'media-playback-pause-symbolic',
    done: 'object-select-symbolic', error: 'dialog-warning-symbolic'};
// a theme colour as [r, g, b, a] in 0..1
const rgba = c => [c.get_red(), c.get_green(), c.get_blue(), c.get_alpha()];
const BARS = 32;
const LEVEL_MS = 50;            // the helper sends one voice level per 50 ms of audio
const FRAME_MS = 33;            // the wave is redrawn at most ~30 times a second, only while it moves
const KEY_LEFTCTRL = 29;
const KEY_LEFTSHIFT = 42;
const KEY_V = 47;
// terminals paste with Ctrl+Shift+V (Ctrl+V means something else there)
const TERMINAL_RE = /kitty|terminal|ptyxis|konsole|alacritty|foot|wezterm|xterm|tilix|terminator|ghostty|blackbox|console|rxvt|st-256color/i;
const KEY_CAPSLOCK = 58;
// messengers: "No Period at the End: In Chats and Terminals" applies to them (and to terminals)
const CHAT_RE = /telegram|signal|discord|slack|element|whatsapp|messenger|teams|zulip|mattermost|fractal|polari|skype|viber|threema|rocket\.?chat|nheko|dino|gajim|tuba|tokodon|beeper|ferdium|franz/i;
// keyboard layouts without Latin letters (xkb names): for the paste keys a Latin one is switched on
const NON_LATIN_RE = /^(ua|ru|by|bg|mk|rs|gr|il|ara|ir|af|iq|sy|th|kz|kg|mn|ge|am|tj|bd|lk|np|la|kh|mm|et)$/;
const LAYOUT_SETTLE_MS = 120;
const CHORD_US = 600000;        // a Caps press this close to the shortcut is not a pause (nor a finish)
const RESTORE_MS = 700;         // put Caps Lock back this long after the last Caps press
const SELF_US = 300000;         // a Caps change this soon after our own Caps tap is ours
const KITTEN = GLib.find_program_in_path('kitten');
const KITTY_RE = /kitty/i;
// A Bluetooth headset switches to headset mode (HFP) when recording starts and back to music mode
// (A2DP) ~4 s after it ends (WirePlumber bluetooth.autoswitch-restore-timeout). For a moment the
// headphones vanish, the speakers become the output, then the headphones come back, and GNOME pops
// the volume OSD on each change. That OSD (only the one from the panel's sound output, not volume
// keys) is hidden while recording and for this long after.
const OSD_QUIET_AFTER_US = 10 * 1000000;
// After a paste the clipboard gets back what it held before (the dictated text does not linger there),
// this long after the paste keys so the app has read it. Not when nothing could be pasted (then the
// text stays in the clipboard), not when you copied something else meanwhile, and a password from a
// password manager (it marks it with x-kde-passwordManagerHint) is never put back, only cleared.
const CLIPBOARD_RESTORE_MS = 1500;
const CLIPBOARD_READ_MS = 500;
const IM_SETTLE_MS = 150;     // let a re-focused text field reach the input method first
// One input-method commit reaches a Wayland app as one protocol message, and the app's Wayland library
// closes its whole connection on a message over 4096 bytes: the window vanishes (seen with kitty and GTK)
// (kitty: "Message length 14284 exceeds limit 4096", about 8000 Cyrillic characters). So a long text
// is typed in parts of at most IM_PART_BYTES of UTF-8, cut after a space. Each part is committed only
// after the Shell has sent the app the "done" of the one before (it does that in an idle at
// PRIORITY_DEFAULT + 1, our next part waits for a PRIORITY_LOW idle): the protocol keeps just the last
// text before a "done", so two parts sent together would lose the first.
const IM_PART_BYTES = 2000;
const IM_PART_MS = 20;
const HISTORY_N = 3;          // texts in the top-bar menu
const TEXT_MIMES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
const SECRET_MIME = 'x-kde-passwordManagerHint';

// the text in parts of at most IM_PART_BYTES bytes of UTF-8 for the input method (see there): cut
// after the last space or line break of a part, else between two characters (never inside one, nor
// before an accent that belongs to the letter in front of it)
function imParts(text, max = IM_PART_BYTES) {
    const parts = [];
    let start = 0, bytes = 0, space = -1;
    for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i);
        const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        const next = i + (cp > 0xffff ? 2 : 1);
        if (bytes + len > max && i > start) {
            let cut = space > start ? space : i;
            while (cut > start + 1 && /\p{M}/u.test(text[cut]))
                cut--;
            if (cut > start + 1 && /[\uDC00-\uDFFF]/.test(text[cut]))
                cut--;          // not between the two halves of an emoji or other astral character
            parts.push(text.slice(start, cut));
            start = cut;
            bytes = new TextEncoder().encode(text.slice(start, i)).length;
            space = -1;
        }
        bytes += len;
        if (/\s/.test(text[i]))
            space = next;
        i = next;
    }
    parts.push(text.slice(start));
    return parts;
}

export class Core {
    // opts.openPrefs: opens the settings window; given by extension.js
    constructor(opts = {}) {
        this._opts = opts;
    }

    enable() {
        this._state = null;                 // null | 'rec' | 'busy'
        this._levels = new Array(BARS).fill(0);
        this._queue = [];                   // levels not yet scrolled in
        this._phase = 0;                    // 0..1: how far the next bar has scrolled in
        this._grabs = new Map();             // action id -> handler (Esc while recording)
        this._accelId = this._keymapId = 0;
        const seat = global.stage.get_context().get_backend().get_default_seat();
        this._kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._keymap = seat.get_keymap();
        // [time, state after, made by us]
        this._capsLog = [[GLib.get_monotonic_time(), this._keymap.get_caps_lock_state(), true]];
        this._selfUntil = 0;
        this._lastChord = this._startedAt = 0;
        this._capsBefore = null;            // Caps Lock state to put back, while a restore is pending
        this._restoreId = 0;
        this._paused = false;
        this._pauseKey = CAPS;              // read from the keys file at each start
        this._escAction = this._pauseAction = 0;
        this._osdQuietUntil = 0;
        this._patchOsd();
        this._buildUi();
        this._buildIndicator();
        this._unsent = [];                  // texts not typed in, while the history is off (menu, memory only)
        this._lockedTexts = 0;              // texts that came while the screen was locked
        this._locked = !!Main.sessionMode.isLocked;
        if (!this._locked)
            this._connectKeyboard();
        this._sessionId = Main.sessionMode.connect('updated', () => this._onSession());
        this._expire();
        this._expireId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
            this._expire();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._cancel();
        if (this._sessionId)
            Main.sessionMode.disconnect(this._sessionId);
        this._sessionId = null;
        this._unsent = [];
        this._unpatchOsd();
        this._disconnectKeyboard();
        this._keymap = null;
        this._clearTimers();
        if (this._restoreId)
            GLib.source_remove(this._restoreId);
        this._restoreId = 0;
        for (const id of this._acts ?? [])
            GLib.source_remove(id);
        this._acts?.clear();
        this._hideAfterDrag = false;
        this._dragEnd();
        this._pill?.destroy();
        this._pill = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._sideProc?.force_exit();
        this._sideProc = null;
        this._historyCancel?.cancel();
        this._historyCancel = null;
        this._historyList = null;
        if (this._expireId)
            GLib.source_remove(this._expireId);
        this._expireId = 0;
        this._kbd = null;
    }

    // keyboard signals: the shortcut grabs (cancel, pause, finish while recording) and the Caps Lock
    // watch. Connected only while the screen is unlocked (GNOME extension review rule for unlock-dialog).
    _connectKeyboard() {
        if (!this._accelId)
            this._accelId = global.display.connect('accelerator-activated', (d, action) => this._grabs.get(action)?.());
        if (!this._keymapId) {
            this._capsLog = [[GLib.get_monotonic_time(), this._keymap.get_caps_lock_state(), true]];
            this._keymapId = this._keymap.connect('state-changed', () => {
                const on = this._keymap.get_caps_lock_state();
                if (this._capsLog.at(-1)[1] !== on) {
                    const t = GLib.get_monotonic_time();
                    const self = t < this._selfUntil;
                    this._capsLog.push([t, on, self]);
                    this._capsLog.splice(0, this._capsLog.length - 32);
                    if (!self) {
                        const [,, mods] = global.get_pointer();
                        this._onCaps(on, t, !!(mods & Clutter.ModifierType.SHIFT_MASK));
                    }
                }
            });
        }
    }

    _disconnectKeyboard() {
        for (const action of [...this._grabs.keys()])
            this._ungrab(action);
        this._finishActions = [];
        this._escAction = this._pauseAction = 0;
        if (this._accelId)
            global.display.disconnect(this._accelId);
        this._accelId = 0;
        if (this._keymapId)
            this._keymap?.disconnect(this._keymapId);
        this._keymapId = 0;
        if (this._restoreId)                    // no Caps Lock tap into the lock screen
            GLib.source_remove(this._restoreId);
        this._restoreId = 0;
        this._capsBefore = null;
    }

    // delete kept recordings older than the privacy setting, the whole history when it is off, and its
    // audio when "Keep Audio" is off (the helper does it too, but only when it runs)
    _expire() {
        const {history, keepMinutes, keepAudio} = readPrivacy();
        const now = GLib.get_real_time() / 1e6;
        this._unsent = (this._unsent ?? []).filter(u => !keepMinutes || now - u.time <= keepMinutes * 60);
        for (const [dir, everything] of [[PENDING_DIR, false], [HISTORY_DIR, !history]]) {
            const names = [];
            try {
                const d = GLib.Dir.open(dir, 0);
                let name;
                while ((name = d.read_name()) !== null)
                    names.push(name);
                d.close();
            } catch (e) {
                continue;
            }
            for (const name of names) {
                const f = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
                try {
                    const mtime = f.query_info('time::modified', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
                        .get_modification_date_time().to_unix();
                    const audioOff = dir === HISTORY_DIR && !keepAudio && name.endsWith('.wav');
                    if (everything || audioOff || (keepMinutes && now - mtime > keepMinutes * 60))
                        f.delete(null);
                } catch (e) {}
            }
        }
    }

    // ------------------------------------------------------------ keys
    _grab(accel, fn) {
        const action = global.display.grab_accelerator(accel, Meta.KeyBindingFlags.NONE);
        if (action === Meta.KeyBindingAction.NONE) {
            console.warn(`dictator: cannot grab ${accel}`);
            return 0;
        }
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
        this._grabs.set(action, fn);
        return action;
    }

    _ungrab(action) {
        if (!action || !this._grabs.has(action))
            return;
        global.display.ungrab_accelerator(action);
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE);
        this._grabs.delete(action);
    }

    _tap(...codes) {
        const t = GLib.get_monotonic_time();
        if (codes.includes(KEY_CAPSLOCK))
            this._selfUntil = t + SELF_US;
        codes.forEach((c, i) => this._kbd.notify_key(t + i, c, Clutter.KeyState.PRESSED));
        [...codes].reverse().forEach((c, i) => this._kbd.notify_key(t + 100 + i, c, Clutter.KeyState.RELEASED));
    }

    // the start shortcut (from extension.js): start, or finish (a Caps press right around it is
    // absorbed, not a pause)
    chord() {
        if (this._locked)
            return;
        const t = GLib.get_monotonic_time();
        this._lastChord = t;
        // the Caps press of the chord toggles the lock, a little before or after this key arrives;
        // one that came before: remember the state before it (a later one is caught in _onCaps)
        const early = this._capsLog.find(([ts, , self]) => !self && ts >= t - CHORD_US);
        if (early)
            this._absorbCaps(!early[1]);
        if (this._state === 'rec') {
            if (this._keys?.finish === SAME)    // else finishing is on its own key (Enter)
                this._stop();
        } else if (!this._state) {
            this._start();
        }
    }

    // a Caps Lock change made by you (not by us); shift: Shift was held
    _onCaps(on, t, shift) {
        const rec = this._state === 'rec';
        // Shift+Caps Lock as the finish key; not the Caps press of a chord that just started recording
        const finishes = rec && shift && this._keys?.finish === SHIFT_CAPS && t - this._startedAt >= CHORD_US;
        const nearChord = t - this._lastChord < CHORD_US;
        const capsPauses = rec && this._pauseKey === CAPS && !(shift && this._keys?.finish === SHIFT_CAPS);
        if (!finishes && !capsPauses && this._capsBefore === null && !nearChord)
            return;                             // a normal Caps Lock press
        this._absorbCaps(!on);
        if (finishes)
            this._stop();
        else if (capsPauses && !nearChord)
            this._togglePause();
    }

    // keys that work only while recording (finish, cancel, and pause unless it is Caps Lock), from the
    // keys file; grabbed, so they never reach the app then (Enter does not send your chat message)
    _grabRecKeys() {
        const keys = readKeys();
        this._keys = keys;
        this._pauseKey = keys.pause;
        this._finishActions = [];
        if (keys.finish !== SAME && keys.finish !== SHIFT_CAPS) {   // those two are not grabbed
            const accels = keys.finish === 'Return' ? ['Return', 'KP_Enter'] : [keys.finish];
            this._finishActions = accels.map(a => this._grab(a, () => this._stop())).filter(Boolean);
            if (!this._finishActions.length)    // could not grab it: the start shortcut finishes instead
                this._keys = {...keys, finish: SAME};
        }
        this._escAction = keys.cancel === NONE ? 0 : this._grab(keys.cancel, () => this._cancel());
        this._pauseAction = keys.pause === NONE || keys.pause === CAPS ? 0
            : this._grab(keys.pause, () => this._togglePause());
    }

    _ungrabRecKeys() {
        for (const a of this._finishActions ?? [])
            this._ungrab(a);
        this._finishActions = [];
        this._ungrab(this._escAction);
        this._ungrab(this._pauseAction);
        this._escAction = this._pauseAction = 0;
    }

    // put Caps Lock back to `before` (the state before the first absorbed press) shortly after the last one
    _absorbCaps(before) {
        if (this._capsBefore === null)
            this._capsBefore = before;
        if (this._restoreId)
            GLib.source_remove(this._restoreId);
        this._restoreId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_MS, () => {
            this._restoreId = 0;
            if (this._keymap && this._keymap.get_caps_lock_state() !== this._capsBefore)
                this._tap(KEY_CAPSLOCK);
            this._capsBefore = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _togglePause() {
        if (this._state !== 'rec')
            return;
        const now = GLib.get_monotonic_time();
        this._paused = !this._paused;
        this._send(this._paused ? 'pause' : 'resume');
        if (this._paused) {
            this._pausedAt = now;
            this._showPaused();
        } else {
            this._t0 += now - this._pausedAt;      // the timer shows recorded time only
            this._resetWave();
            this._showRecording(false);
        }
    }

    // ------------------------------------------------------------ screen lock
    // The extension stays on while the screen is locked (metadata.json "session-modes"), so a recording
    // is not lost. On lock: the microphone stops listening (the recording is finished and transcribed),
    // nothing is shown or pasted on the lock screen, the top-bar menu with your last texts is hidden.
    // A text that comes meanwhile waits in the microphone menu (never typed into the lock screen).
    _onSession() {
        const locked = !!Main.sessionMode.isLocked;
        if (locked === this._locked)
            return;
        this._locked = locked;
        if (locked) {
            if (this._state === 'rec')
                this._stop();
            this._disconnectKeyboard();
            this._indicator?.menu.close();
            this._indicator?.container.hide();
            this._hideAfterDrag = false;
            this._dragEnd();
            this._clearTimers();
            this._pill.remove_all_transitions();
            this._pill.hide();
            return;
        }
        this._connectKeyboard();
        this._indicator?.container.show();
        if (this._lockedTexts) {
            this._lockedTexts = 0;
            this._show('done', 'The screen was locked: the text is in the microphone menu', 5000);
        } else if (this._state === 'busy' || this._sideProc) {
            this._show('busy', 'Transcribing…');
        }
    }

    // A text that could not be typed in waits in the microphone menu: the helper's history has it; with
    // the history off it is kept here, in memory only, for as long as the history would keep it.
    _keep(text) {
        if (this._locked)
            this._lockedTexts++;
        if (readPrivacy().history)
            return;
        const now = GLib.get_real_time();
        this._unsent.unshift({stamp: `mem-${now}`, time: Math.floor(now / 1e6), text});
        this._unsent.splice(HISTORY_N);
    }

    // ------------------------------------------------------------ clipboard
    _setClipboard(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    // what the clipboard holds now, to put back after the paste: {text} / {mime, bytes} / null
    _saveClipboard(done) {
        const cb = St.Clipboard.get_default();
        const mimes = cb.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        const textMime = TEXT_MIMES.find(m => mimes.includes(m));
        const mime = textMime ?? mimes[0];
        if (!mime || mimes.includes(SECRET_MIME)) {
            done(null);
            return;
        }
        // the app that owns the clipboard has to send it; one that hangs must not stop the paste:
        // after CLIPBOARD_READ_MS paste anyway, and leave the clipboard as it is then (saved: undefined)
        let answered = false;
        const giveUp = this._act(CLIPBOARD_READ_MS, () => {
            answered = true;
            this._note('the clipboard owner did not answer: pasting without restoring the clipboard');
            done(undefined);
        });
        cb.get_content(St.ClipboardType.CLIPBOARD, mime, (c, bytes) => {
            if (answered || !this._kbd)     // too late, or the extension was disabled meanwhile
                return;
            answered = true;
            this._unact(giveUp);
            const data = bytes?.get_size() ? bytes : null;
            if (!data)
                done(null);
            else if (textMime)
                done({text: new TextDecoder().decode(data.toArray())});
            else
                done({mime, bytes: data});
        });
    }

    _restoreClipboard({text, saved}) {
        const cb = St.Clipboard.get_default();
        cb.get_text(St.ClipboardType.CLIPBOARD, (c, now) => {
            if (now !== text || !this._kbd)     // you copied something else meanwhile: leave it
                return;
            if (!saved)
                cb.set_text(St.ClipboardType.CLIPBOARD, '');
            else if (saved.text !== undefined)
                cb.set_text(St.ClipboardType.CLIPBOARD, saved.text);
            else
                cb.set_content(St.ClipboardType.CLIPBOARD, saved.mime, saved.bytes);
        });
    }

    // ------------------------------------------------------------ volume OSD during headset switch
    _patchOsd() {
        const slider = Main.panel.statusArea.quickSettings?._volumeOutput?._output;
        if (!slider || typeof slider.showOSD !== 'function')
            return;
        const proto = Object.getPrototypeOf(slider);
        const core = this;
        slider.showOSD = function () {
            if (core._state || GLib.get_monotonic_time() < core._osdQuietUntil)
                return;
            proto.showOSD.call(this);
        };
        this._osdSlider = slider;
    }

    _unpatchOsd() {
        if (this._osdSlider)
            delete this._osdSlider.showOSD;      // back to GNOME's own method
        this._osdSlider = null;
    }

    _quietOsd() {
        this._osdQuietUntil = GLib.get_monotonic_time() + OSD_QUIET_AFTER_US;
    }

    // ------------------------------------------------------------ helper process
    _start() {
        if (!this._helperThere())
            return;
        try {
            this._proc = Gio.Subprocess.new([HELPER],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            this._show('error', `Cannot start dictation: ${e.message}`, 4000);
            return;
        }
        this._state = 'rec';
        this._rememberTarget();
        this._grabRecKeys();
        this._t0 = this._startedAt = GLib.get_monotonic_time();
        this._resetWave();
        this._stdin = this._proc.get_stdin_pipe();
        this._reader = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe()});
        this._readLine(this._proc);
        this._proc.wait_async(null, (p) => {
            if (p === this._proc && this._state)
                this._finish();
        });
        this._showRecording();
    }

    // the helper is installed separately (it cannot come with the extension): say so if it is not
    _helperThere() {
        if (GLib.file_test(HELPER, GLib.FileTest.IS_EXECUTABLE))
            return true;
        this._pickMonitor();
        this._show('error', 'The speech engine is not installed: microphone menu → Settings', 5000);
        return false;
    }

    _send(cmd) {
        try {
            this._stdin?.write_all(new TextEncoder().encode(cmd + '\n'), null);
            this._stdin?.flush(null);
        } catch (e) {}
    }

    _stop() {
        if (this._state !== 'rec')
            return;
        this._state = 'busy';
        this._paused = false;
        this._micColor(null);
        this._quietOsd();
        this._ungrabRecKeys();
        this._send('stop');
        this._show('busy', 'Transcribing…');
    }

    _cancel() {
        if (!this._state)
            return;
        this._quietOsd();
        this._send('cancel');
        try {
            this._stdin?.close(null);       // the helper also ends at the end of its input
        } catch (e) {}
        this._finish();
        this._target = null;
        this._hide();
    }

    _finish() {
        if (this._state === 'rec')              // helper ended the recording itself
            this._quietOsd();
        this._ungrabRecKeys();
        this._state = null;
        this._paused = false;
        this._micColor(null);
        this._proc = this._stdin = this._reader = null;
        this._clearTimers();
    }

    _readLine(proc) {
        this._reader?.read_line_async(GLib.PRIORITY_DEFAULT, null, (r, res) => {
            if (proc !== this._proc)
                return;
            let line;
            try {
                [line] = r.read_line_finish_utf8(res);
            } catch (e) {
                line = null;
            }
            if (line === null) {                     // helper exited
                if (this._state) {
                    this._finish();
                    this._show('error', 'Dictation stopped unexpectedly', 3000);
                }
                return;
            }
            this._onLine(line);
            if (proc === this._proc)
                this._readLine(proc);
        });
    }

    _onLine(line) {
        const kind = line[0], rest = line.slice(2);
        if (kind === 'L') {
            this._queue.push(Math.max(0, Math.min(1, parseFloat(rest) || 0)));
            if (this._queue.length > 8)         // never lag behind your voice
                this._queue.splice(0, this._queue.length - 4);
            this._tick();
        } else if (kind === 'S') {
            if (this._state === 'rec') {     // the helper finished by itself (auto-stop after silence)
                this._paused = false;
                this._quietOsd();
                this._ungrabRecKeys();
            }
            this._state = 'busy';
            this._show('busy', 'Transcribing…');
        } else if (kind === 'T') {
            let text = '';
            try {
                text = cleanText(JSON.parse(rest));
            } catch (e) {}
            const target = this._target;
            this._target = null;
            this._finish();
            this._deliver(text, target);
        } else if (kind === 'E') {
            this._target = null;
            this._finish();
            this._show('error', rest || 'Error', rest.includes('kept') ? 7000 : 3500);
        }
    }

    // ------------------------------------------------------------ where the text goes
    // the window with the cursor now, and in kitty also its focused window (= tab) id
    _rememberTarget() {
        const win = global.display.focus_window;
        const target = this._target = win ? {win, kittyId: null, kittySock: null} : null;
        const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
        this._appIcon.gicon = app?.get_icon() ?? null;
        this._appIcon.accessible_name = app?.get_name() ?? '';
        if (!win || !KITTEN || !KITTY_RE.test(win.get_wm_class() ?? ''))
            return;
        const sock = GLib.build_filenamev([GLib.get_user_runtime_dir(), `kitty-${win.get_pid()}`]);
        if (!GLib.file_test(sock, GLib.FileTest.EXISTS))
            return;
        target.kittySock = sock;
        this._kitten(sock, ['ls', '--match', 'state:focused'], out => {
            try {
                for (const osw of JSON.parse(out))
                    for (const tab of osw.tabs ?? [])
                        for (const w of tab.windows ?? [])
                            if (target.kittyId === null || w.is_focused)
                                target.kittyId = w.id;
            } catch (e) {}          // kitty started before this was allowed: window only
        });
    }

    _kitten(sock, args, done) {
        let proc;
        try {
            proc = Gio.Subprocess.new([KITTEN, '@', '--to', `unix:${sock}`, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            done(null);
            return;
        }
        const kill = this._act(3000, () => proc.force_exit());
        proc.communicate_utf8_async(null, null, (p, res) => {
            this._unact(kill);
            let out = null;
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                out = p.get_successful() ? stdout : null;
            } catch (e) {}
            if (this._kbd)          // extension still enabled
                done(out);
        });
    }

    _alive(win) {
        return !!win && global.get_window_actors().some(a => a.meta_window === win);
    }

    // what happened to a text, for debugging (a debug message: shown only with G_MESSAGES_DEBUG): the
    // app, the keys, the keyboard layout. Never the text itself.
    _note(msg) {
        let layout = '?';
        try {
            layout = Keyboard.getInputSourceManager().currentSource?.id ?? '?';
        } catch (e) {}
        console.debug(`dictator: ${msg} [layout ${layout}]`);
    }

    // Put the text where the recording started (never into another window). It is typed in through the
    // input method, the way the on-screen keyboard types: no clipboard, no key presses, any keyboard
    // layout. An app without that (some X11 / Electron apps) gets a paste through the clipboard only if
    // Settings allow it; otherwise, like when the window is gone, the text waits in the microphone menu.
    _deliver(text, target) {
        if (!text) {
            this._note('no text: nothing to insert');
            this._show('error', 'No speech recognised', 3000);
            return;
        }
        if (this._locked) {         // never typed into the lock screen
            this._note('screen locked: text kept for the menu');
            this._keep(text);
            return;
        }
        if (!target) {              // nothing had focus when you started: insert where you are
            this._insert(text, 0);
            return;
        }
        const win = target.win;
        if (!this._alive(win)) {
            this._missed(text, 'That window was closed');
            return;
        }
        const away = global.display.focus_window !== win;
        if (away)
            Main.activateWindow(win);
        const tab = target.kittyId !== null
            ? cb => this._kitten(target.kittySock, ['focus-window', '--match', `id:${target.kittyId}`], () => cb())
            : cb => cb();
        tab(() => {
            // wait until that window really has the keyboard (up to 1.5 s), then insert
            const t0 = GLib.get_monotonic_time();
            const check = () => {
                if (!this._alive(win))
                    this._missed(text, 'That window was closed');
                else if (global.display.focus_window === win)
                    this._insert(text, away || target.kittyId !== null ? 150 : 0);
                else if (GLib.get_monotonic_time() - t0 > 1500000)
                    this._missed(text, 'Could not go back to that window');
                else
                    this._act(50, check);
            };
            check();
        });
    }

    // the text as this app should get it: dictated line breaks (a space in a terminal: a line break
    // there would run a command), no final period in chats and terminals if chosen, a space after
    _forApp(text, app) {
        const sp = readSpeech();
        const term = TERMINAL_RE.test(app);
        let t = text.replaceAll(NEWLINE_MARK, term ? ' ' : '\n');
        if (term)
            t = t.replace(/ {2,}/g, ' ').trim();
        if (sp.finalPeriod === 'chats' && (term || CHAT_RE.test(app)) && /[^.]\.$/.test(t))
            t = t.slice(0, -1);
        return sp.spaceAfter ? `${t} ` : t;
    }

    _missed(text, why) {
        this._note(`${why}: text kept for the menu`);
        this._keep(text);
        this._show('error', `${why}: the text is in the microphone menu`, 4500);
    }

    _insert(text, settle) {
        // a moment for the app's text field to report its focus to the input method
        this._act(IM_SETTLE_MS + settle, () => {
            if (this._locked) {
                this._keep(text);
                return;
            }
            const win = global.display.focus_window;
            const app = win ? `${win.get_wm_class() ?? ''} ${win.get_gtk_application_id?.() ?? ''}`.trim() : 'no window';
            const typed = this._forApp(text, app);
            if (Main.inputMethod?.currentFocus) {
                this._commit(imParts(typed), text, app, win, Main.inputMethod.currentFocus);
            } else if (readPrivacy().clipboard) {
                this._note(`"${app}" takes no typed text: pasting through the clipboard (allowed in Settings)`);
                this._saveClipboard(saved => {
                    if (this._locked) {
                        this._keep(text);
                        return;
                    }
                    this._setClipboard(typed);
                    this._paste(0, {text: typed, saved});
                });
            } else {
                this._missed(text, 'This app does not take typed text');
            }
        });
    }

    // type the parts in one by one, while the same window and text field have the keyboard; if that
    // changes (or the screen locks) the rest is not typed anywhere else and the text waits in the menu
    _commit(parts, text, app, win, focus) {
        Main.inputMethod.commit(parts[0]);
        if (parts.length === 1) {
            this._note(`typed in through the input method into "${app}"`);
            this._show('done', 'Inserted', 1500);
            return;
        }
        this._act(IM_PART_MS, () => this._idle(() => {
            if (this._locked)
                this._keep(text);
            else if (global.display.focus_window !== win || Main.inputMethod?.currentFocus !== focus)
                this._missed(text, 'Typing was interrupted');
            else
                this._commit(parts.slice(1), text, app, win, focus);
        }));
    }

    _paste(settle = 0, restore = null) {
        this._show('done', 'Pasted', 1500);
        // with Caps Lock on, an upper-case V is not a paste everywhere: lift it for the paste, then put it back
        this._act(300 + settle, () => this._pasteNow(false, restore));
    }

    _pasteNow(waited = false, restore = null) {
        if (this._locked) {             // locked just now: no keys into the lock screen
            if (restore)
                this._keep(restore.text);
            return;
        }
        if (this._restoreId) {          // Caps Lock is about to be put back: paste after that
            this._act(100, () => this._pasteNow(true, restore));
            return;
        }
        if (waited) {                   // let the keymap see that Caps tap first
            this._act(150, () => this._pasteNow(false, restore));
            return;
        }
        const caps = this._keymap.get_caps_lock_state();
        if (caps)
            this._tap(KEY_CAPSLOCK);
        const win = global.display.focus_window;
        const app = win ? `${win.get_wm_class() ?? ''} ${win.get_gtk_application_id?.() ?? ''}`.trim() : 'no window';
        const term = !!win && TERMINAL_RE.test(app);
        this._act(caps ? 120 : 0, () => this._withLatinLayout(switched => {
            if (term)
                this._tap(KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V);
            else
                this._tap(KEY_LEFTCTRL, KEY_V);
            this._note(`pasted with ${term ? 'Ctrl+Shift+V' : 'Ctrl+V'} into "${app}"` +
                `${switched ? `, layout ${switched} for the paste` : ''}${caps ? ', Caps Lock lifted' : ''}` +
                `${restore && restore.saved === undefined ? ', clipboard not restored' : ''}`);
            if (caps)
                this._act(150, () => this._tap(KEY_CAPSLOCK));
            if (restore && restore.saved !== undefined)
                this._act(CLIPBOARD_RESTORE_MS, () => this._restoreClipboard(restore));
        }));
    }

    // The paste keys are sent as key positions: with a Cyrillic (Greek, ...) layout on, the "V" key is
    // "м", and many apps do not take Ctrl+м as a paste. So for the paste the first Latin layout is
    // switched on, and the one you had is put back right after. fn(id of the layout used, or null).
    _withLatinLayout(fn) {
        let mgr, cur, latin;
        try {
            mgr = Keyboard.getInputSourceManager();
            cur = mgr.currentSource;
            const nonLatin = s => s.type === 'xkb' && !/latin/i.test(s.id) &&
                NON_LATIN_RE.test(s.id.split(/[+(]/)[0]);
            if (cur && nonLatin(cur))
                latin = Object.values(mgr.inputSources).find(s => s.type === 'xkb' && !nonLatin(s));
        } catch (e) {
            console.warn(`dictator: keyboard layouts: ${e}`);
        }
        if (!latin) {
            fn(null);
            return;
        }
        latin.activate(false);
        this._act(LAYOUT_SETTLE_MS, () => {           // let the new layout reach the keyboard first
            fn(latin.id);
            this._act(LAYOUT_SETTLE_MS, () => {       // back to yours, unless you switched meanwhile
                if (mgr.currentSource === latin)
                    cur.activate(false);
            });
        });
    }

    // ------------------------------------------------------------ top bar: last recordings
    _buildIndicator() {
        const ind = this._indicator = new PanelMenu.Button(0.5, 'Dictator', false);
        ind.set_style('-natural-hpadding: 4px; -minimum-hpadding: 2px;');
        this._micIcon = new St.Icon({icon_name: 'audio-input-microphone-symbolic', style_class: 'system-status-icon'});
        ind.add_child(this._micIcon);
        this._section = new PopupMenu.PopupMenuSection();
        ind.menu.addMenuItem(this._section);
        ind.menu.connect('open-state-changed', (m, open) => {
            if (!open)
                return;
            this._fillMenu();           // at once, with the texts read last time, then the new ones
            this._loadHistory(() => {
                if (this._indicator?.menu.isOpen)
                    this._fillMenu();
            });
        });
        this._fillMenu();           // a menu without items does not open
        Main.panel.addToStatusArea('dictation-history', ind, 0, 'right');
    }

    // the recent texts, kept by the helper in RAM ($XDG_RUNTIME_DIR/dictate-history), as last read
    _history() {
        return this._historyList ?? [];
    }

    // read them again, asynchronously; done() once they are in
    _loadHistory(done) {
        const names = [];
        try {
            const dir = GLib.Dir.open(HISTORY_DIR, 0);
            let name;
            while ((name = dir.read_name()) !== null) {
                if (/^rec-\d{8}-\d{6}\.json$/.test(name))
                    names.push(name);
            }
            dir.close();
        } catch (e) {}                  // no history yet
        this._historyCancel?.cancel();
        const cancel = this._historyCancel = new Gio.Cancellable();
        const list = [];
        let left = names.length;
        const finish = () => {
            if (cancel.is_cancelled())
                return;
            this._historyList = list;
            done();
        };
        if (!left)
            finish();
        for (const name of names) {
            Gio.File.new_for_path(`${HISTORY_DIR}/${name}`).load_contents_async(cancel, (f, res) => {
                try {
                    const [, bytes] = f.load_contents_finish(res);
                    const h = JSON.parse(new TextDecoder().decode(bytes));
                    const stamp = name.slice(0, -5);
                    list.push({stamp, time: Number(h.time) || 0, text: cleanText(h.text),
                        audio: GLib.file_test(`${HISTORY_DIR}/${stamp}.wav`, GLib.FileTest.IS_REGULAR)});
                } catch (e) {}          // gone meanwhile, or cancelled
                if (--left === 0)
                    finish();
            });
        }
    }

    _failedCount() {
        let n = 0;
        try {
            const dir = GLib.Dir.open(PENDING_DIR, 0);
            let name;
            while ((name = dir.read_name()) !== null)
                n += name.endsWith('.wav') ? 1 : 0;
            dir.close();
        } catch (e) {}
        return n;
    }

    // The menu, kept minimal (GNOME HIG): the last 3 texts (click: copy it), failed recordings when
    // there are any, and Settings. With "Keep Audio" on (Settings, Privacy) a text opens a submenu
    // instead: copy it, or transcribe its recording again, as it was or in one of the chosen languages.
    _fillMenu() {
        const sec = this._section;
        sec.removeAll();
        this._expire();
        const busy = !!this._state || !!this._sideProc;
        const privacy = readPrivacy();
        const list = [...(privacy.history ? this._history() : []), ...this._unsent]
            .filter(h => h.text).sort((a, b) => b.time - a.time).slice(0, HISTORY_N);
        if (!list.length) {
            const empty = new PopupMenu.PopupMenuItem(privacy.history ? 'No recordings' : 'History is off',
                {reactive: false, can_focus: false});
            empty.label.add_style_class_name('dictation-menu-dim');
            sec.addMenuItem(empty);
        }
        const names = new Map(LANGUAGES.map(([c, en]) => [c, en]));
        const again = privacy.keepAudio ? againLanguages(privacy) : [];
        for (const h of list) {
            const redo = privacy.keepAudio && h.audio;
            const item = redo ? new PopupMenu.PopupSubMenuMenuItem(h.text.replaceAll(NEWLINE_MARK, ' '))
                : new PopupMenu.PopupMenuItem(h.text.replaceAll(NEWLINE_MARK, ' '));
            item.label.add_style_class_name('dictation-menu-text');
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            item.label.x_expand = true;
            const time = new St.Label({style_class: 'dictation-menu-dim dictation-menu-time',
                text: GLib.DateTime.new_from_unix_local(h.time).format('%H:%M'),
                y_align: Clutter.ActorAlign.CENTER});
            if (redo) {         // the time before the submenu arrow
                item.insert_child_below(time, item.get_children().at(-1));
                item.menu.addAction('Copy', () => this._copy(h.text));
                for (const lang of [null, ...again]) {
                    const label = lang ? `Again in ${names.get(lang) ?? lang}` : 'Transcribe Again';
                    item.menu.addAction(label, () => this._redo(h.stamp, lang)).setSensitive(!busy);
                }
            } else {
                item.add_child(time);
                item.connect('activate', () => this._copy(h.text));
            }
            sec.addMenuItem(item);
        }
        const failed = this._failedCount();
        if (failed) {
            const item = new PopupMenu.PopupMenuItem(failed > 1 ? `${failed} failed recordings` : 'Failed recording');
            item.label.x_expand = true;
            item.add_child(new St.Label({style_class: 'dictation-menu-dim', text: 'Retry',
                y_align: Clutter.ActorAlign.CENTER}));
            item.setSensitive(!busy);       // not while recording: the recording in progress sits there too
            item.connect('activate', () => this._retry());
            sec.addMenuItem(item);
        }
        if (this._opts.openPrefs) {
            sec.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            sec.addAction('Settings', () => {
                try {
                    this._opts.openPrefs();
                } catch (e) {
                    console.error(`dictator: settings window: ${e}`);
                }
            });
        }
    }

    // copying is your own action: the only time the text goes to the clipboard (unless Settings allow
    // the paste fallback)
    _copy(text) {
        this._setClipboard(text.replaceAll(NEWLINE_MARK, '\n'));
        if (!this._state)
            this._show('done', 'Copied', 1500);
    }

    // transcribe the failed recordings again; the texts go to the menu
    _retry() {
        this._runSide(['--retry'], (texts, err) => {
            texts.forEach(t => this._keep(t));
            if (texts.length)
                this._show('done', `Recovered: the text is in the microphone menu${err ? ` (${err})` : ''}`, 4000);
            else
                this._show('error', err ?? 'No speech recognised', 3500);
        });
    }

    // transcribe a recording from the history again (lang: a language code, or null for the usual ones);
    // the helper puts the new text into the history, and it is copied, like a click on a text
    _redo(stamp, lang) {
        this._runSide(['--redo', stamp, ...(lang ? [lang] : [])], (texts, err) => {
            if (texts.length) {
                this._setClipboard(texts[0].replaceAll(NEWLINE_MARK, '\n'));
                this._show('done', 'New text copied', 2500);
            } else {
                this._show('error', err ?? 'No speech recognised', 3500);
            }
        });
    }

    // Run the helper for work outside a recording (one at a time, never during one), with the
    // "Transcribing again" pill. done(texts, error) gets the helper's T and E lines, unless a new
    // recording started meanwhile (its pill is not touched then; texts of a retry are kept anyway).
    _runSide(args, done) {
        if (this._state || this._sideProc || !this._helperThere())
            return;
        let proc;
        try {
            proc = this._sideProc = Gio.Subprocess.new([HELPER, ...args], Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            this._show('error', `Cannot start dictation: ${e.message}`, 4000);
            return;
        }
        this._pickMonitor();
        this._show('busy', 'Transcribing again…');
        proc.communicate_utf8_async(null, null, (p, res) => {
            if (p !== this._sideProc)
                return;
            this._sideProc = null;
            let out = '';
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch (e) {}
            const lines = (out ?? '').split('\n');
            const texts = lines.filter(l => l.startsWith('T ')).map(l => {
                try {
                    return cleanText(JSON.parse(l.slice(2)));
                } catch (e) {
                    return '';
                }
            }).filter(Boolean);
            const err = lines.find(l => l.startsWith('E '))?.slice(2);
            if (this._state) {          // a new recording started meanwhile: do not touch its pill
                if (args[0] === '--retry')
                    texts.forEach(t => this._keep(t));
                return;
            }
            done(texts, err);
        });
    }

    // ------------------------------------------------------------ UI
    // The pill at the bottom, in the style of a libadwaita toast / GNOME OSD: a round status badge (a
    // symbolic icon on a coloured circle; a spinner in the system accent colour while transcribing), the
    // voice level, the timer, and keycaps that show which keys work now. Colours and shapes are in
    // stylesheet.css (dark) and stylesheet-light.css: GNOME Shell picks the one for its light/dark style.
    _buildUi() {
        const y_align = Clutter.ActorAlign.CENTER;
        // bms-popup-blur-target: opt in to Blur my Shell's popup blur (menus, OSDs), so with that extension the pill
        // is glass like the rest of the Shell; it keeps the pill's own capsule radius. Without it the class does nothing.
        this._pill = new St.BoxLayout({style_class: 'dictation-pill bms-popup-blur-target', reactive: true,
            visible: false, y_align});
        this._pill.set_cursor_type(Clutter.CursorType.GRAB);
        this._pill.connect('button-press-event', (a, e) => this._dragStart(e));
        this._pill.connect('motion-event', (a, e) => this._dragMove(e));
        this._pill.connect('button-release-event', () => this._dragEnd());
        this._badgeIcon = new St.Icon({style_class: 'dictation-badge-icon', icon_name: 'audio-input-microphone-symbolic',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._badge = new St.Bin({style_class: 'dictation-badge', child: this._badgeIcon, y_align});
        this._spinner = new St.DrawingArea({style_class: 'dictation-spinner', visible: false, y_align,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this._spinner.connect('repaint', a => this._drawSpinner(a));
        this._wave = new St.DrawingArea({style_class: 'dictation-wave', y_align});
        this._wave.connect('repaint', a => this._drawWave(a));
        this._time = new St.Label({style_class: 'dictation-time', text: '0:00', y_align});
        this._status = new St.Label({style_class: 'dictation-status', y_align});
        // where the text will go: the icon of the app that had the focus when the recording started
        this._appIcon = new St.Icon({style_class: 'dictation-app-icon', icon_size: 20, visible: false, y_align});
        for (const w of [this._badge, this._spinner, this._wave, this._time, this._status, this._appIcon])
            this._pill.add_child(w);
        // plain child of the UI group: drawn on top of the windows
        Main.layoutManager.uiGroup.add_child(this._pill);
    }

    // ------------------------------------------------------------ dragging the pill
    // Press and drag moves the pill; it stays there for the next recordings too (keys.js readPillSpot,
    // a share of the monitor, so it works on any monitor). A double-click puts it back where Settings say.
    // While the button is held the stage grab sends every motion here, also when the pointer outruns
    // the pill. Nothing reaches the app under the pill, and the text still goes to the window where the
    // recording started.
    _dragStart(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (this._drag)
            return Clutter.EVENT_STOP;
        const [px, py] = event.get_coords();
        const {double_click_time: ms, double_click_distance: far} = Clutter.Settings.get_default();
        const last = this._lastPress;
        this._lastPress = {time: event.get_time(), x: px, y: py};
        if (last && event.get_time() - last.time <= ms && Math.hypot(px - last.x, py - last.y) <= far) {
            this._lastPress = null;     // a double-click: back to the place chosen in Settings
            writePillSpot(null);
            this._place();
            return Clutter.EVENT_STOP;
        }
        this._pill.remove_transition('translation-y');
        this._pill.translation_y = 0;
        this._drag = {dx: px - this._pill.x, dy: py - this._pill.y, moved: false,
            grab: global.stage.grab(this._pill)};
        this._pill.set_cursor_type(Clutter.CursorType.GRABBING);
        return Clutter.EVENT_STOP;
    }

    _dragMove(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        const m = this._monitorAt(px, py);
        const [x, y] = this._clamp(m, px - this._drag.dx, py - this._drag.dy, ...this._pill.get_size());
        this._pill.set_position(x, y);
        this._monitor = m;
        this._drag.moved = true;
        return Clutter.EVENT_STOP;
    }

    _dragEnd() {
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;
        this._drag = null;
        drag.grab.dismiss();
        this._pill?.set_cursor_type(Clutter.CursorType.GRAB);
        const m = this._monitor;
        if (drag.moved && m) {
            const [w, h] = this._pill.get_size();
            writePillSpot({x: Math.min(1, Math.max(0, (this._pill.x + w / 2 - m.x) / m.width)),
                y: Math.min(1, Math.max(0, (this._pill.y + h / 2 - m.y) / m.height))});
        }
        if (this._hideAfterDrag) {
            this._hideAfterDrag = false;
            this._hide();
        }
        return Clutter.EVENT_STOP;
    }

    _monitorAt(x, y) {
        const lm = Main.layoutManager;
        return lm.monitors.find(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ??
            this._monitor ?? lm.primaryMonitor;
    }

    // the pill's top-left corner at (x, y), moved so that the whole w x h pill is on monitor m
    _clamp(m, x, y, w, h) {
        return [Math.round(Math.min(Math.max(x, m.x), m.x + m.width - w)),
            Math.round(Math.min(Math.max(y, m.y), m.y + m.height - h))];
    }

    // the monitor you type on: the focused window's, else the one under the pointer
    _pickMonitor() {
        const win = global.display.focus_window;
        const idx = win ? win.get_monitor() : global.display.get_current_monitor();
        this._monitor = Main.layoutManager.monitors[idx] ?? Main.layoutManager.primaryMonitor;
    }

    _place() {
        const m = Main.layoutManager.monitors.includes(this._monitor) ? this._monitor : Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        if (this._drag)                 // you are moving it
            return;
        const [, w] = this._pill.get_preferred_width(-1);
        const [, h] = this._pill.get_preferred_height(w);
        const spot = readPillSpot();
        if (spot) {                     // where you dragged it
            this._pill.set_position(...this._clamp(m, m.x + spot.x * m.width - w / 2,
                m.y + spot.y * m.height - h / 2, w, h));
            return;
        }
        // Settings: at the bottom (like a toast) or at the top, under the top bar
        const top = m.y + (m === Main.layoutManager.primaryMonitor ? Main.panel.height : 0) + 16;
        const y = this._pillTop ? top : m.y + m.height - h - 48;
        this._pill.set_position(Math.round(m.x + (m.width - w) / 2), Math.round(y));
    }

    // slide from the nearer screen edge: up from below, or down from above
    get _slide() {
        return this._pillTop ? -16 : 16;
    }

    // fade and slide in from below like a libadwaita toast (only when it was hidden)
    _present() {
        Main.layoutManager.uiGroup.set_child_above_sibling(this._pill, null);
        if (!this._pill.visible) {          // slides in from the nearer screen edge
            const spot = readPillSpot();
            this._pillTop = spot ? spot.y < 0.5 : readSpeech().pill === 'top';
        }
        this._place();
        if (this._pill.visible && this._pill.opacity === 255 && !this._hiding)
            return;
        this._hiding = false;
        this._pill.remove_all_transitions();
        if (!this._pill.visible) {
            this._pill.opacity = 0;
            this._pill.translation_y = this._slide;
        }
        this._pill.show();
        this._pill.ease({opacity: 255, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // the round badge: 'rec' | 'pause' | 'busy' (spinner) | 'done' | 'error'
    _setBadge(kind) {
        for (const k of Object.keys(BADGE_ICON))
            this._badge.remove_style_class_name(`dictation-${k}`);
        this._badge.remove_all_transitions();
        this._badge.opacity = 255;
        const busy = kind === 'busy';
        this._micColor(kind);
        this._badge.visible = !busy;
        this._spinner.visible = busy;
        if (busy) {
            if (!this._spinner.get_transition('rotation-angle-z')) {
                this._spinner.rotation_angle_z = 0;
                this._spinner.ease({rotation_angle_z: 360, duration: 900, repeatCount: -1,
                    mode: Clutter.AnimationMode.LINEAR});
            }
            return;
        }
        this._spinner.remove_all_transitions();
        this._badge.add_style_class_name(`dictation-${kind}`);
        this._badgeIcon.icon_name = BADGE_ICON[kind];
    }

    _showRecording(newMonitor = true) {
        this._micColor('rec');
        if (newMonitor)
            this._pickMonitor();
        this._clearTimers();
        this._setBadge('rec');
        this._wave.show();
        this._time.show();
        this._status.hide();
        this._appIcon.visible = !!this._appIcon.gicon;
        if (newMonitor)
            this._time.text = '0:00';
        this._present();
        this._startWave();
        this._pulse = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._badge.ease({opacity: this._badge.opacity > 200 ? 150 : 255, duration: 650,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // the top-bar icon takes the colour of the pill's state: rec, pause, busy, done, error (null: plain)
    _micColor(kind) {
        if (!this._micIcon)
            return;
        for (const k of Object.keys(BADGE_ICON).concat('busy'))
            this._micIcon.remove_style_class_name(`dictation-mic-${k}`);
        if (kind)
            this._micIcon.add_style_class_name(`dictation-mic-${kind}`);
    }

    _showPaused() {
        this._micColor('pause');
        this._clearTimers();
        this._setBadge('pause');
        this._wave.hide();
        this._time.show();
        this._appIcon.visible = !!this._appIcon.gicon;
        this._status.text = 'Paused';
        this._status.show();
        this._present();
    }

    _tick() {
        if (this._state !== 'rec' || this._paused)
            return;
        const s = Math.floor((GLib.get_monotonic_time() - this._t0) / 1e6);
        const txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (this._time.text !== txt)
            this._time.text = txt;
    }

    _show(kind, msg, hideAfter = 0) {
        if (this._locked)               // nothing on the lock screen
            return;
        this._clearTimers();
        this._setBadge(kind);
        this._wave.hide();
        this._time.visible = kind === 'busy';
        // the app icon only while this recording's text is on its way (not for Retry, not when done)
        this._appIcon.visible = kind === 'busy' && this._state === 'busy' && !!this._appIcon.gicon;
        this._status.text = msg;
        this._status.show();
        this._present();
        if (hideAfter)
            this._later(hideAfter, () => this._hide());
    }

    _hide() {
        if (this._drag) {               // not out from under the pointer: once you let go
            this._hideAfterDrag = true;
            return;
        }
        this._clearTimers();
        this._hiding = true;
        this._pill.ease({opacity: 0, translation_y: this._slide, duration: 200, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._hiding = false;
                if (!this._state) {
                    this._micColor(null);
                    this._pill.hide();
                    this._spinner.remove_all_transitions();
                }
            }});
    }

    _resetWave() {
        this._levels.fill(0);
        this._queue = [];
        this._phase = 0;
        this._wave?.queue_repaint();
    }

    // The wave scrolls at an even pace (the helper's levels come in bursts): a level waits in the queue,
    // then slides in from the right while it grows to its height. Redrawn at most every FRAME_MS, only
    // while recording and not paused, and not at all while it shows silence (nothing moves then).
    _startWave() {
        if (this._waveId)
            return;
        let last = GLib.get_monotonic_time();
        this._waveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            const now = GLib.get_monotonic_time();
            const dt = (now - last) / 1000;
            last = now;
            if (this._state !== 'rec' || this._paused || !this._pill.visible) {
                this._waveId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!this._queue.length) {          // waiting for the next level: hold still
                this._phase = 0;
                return GLib.SOURCE_CONTINUE;
            }
            const quiet = this._levels.every(v => v === 0) && this._queue.every(v => v === 0);
            // a little faster when levels pile up, so the wave never lags behind
            this._phase += dt / LEVEL_MS * (this._queue.length > 3 ? 1.5 : 1);
            while (this._phase >= 1 && this._queue.length) {
                this._levels.push(this._queue.shift());
                this._levels.shift();
                this._phase -= 1;
            }
            if (!this._queue.length)
                this._phase = 0;
            if (!quiet)
                this._wave.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWave() {
        if (this._waveId)
            GLib.source_remove(this._waveId);
        this._waveId = 0;
    }

    // the voice level: rounded bars in the text colour; faint = barely heard, warning colour = too loud
    _drawWave(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const node = area.get_theme_node();
        const [fr, fg, fb, fa] = rgba(node.get_foreground_color());
        const [ok, loudColor] = node.lookup_color('-dictation-loud-color', false);
        const loud = ok ? rgba(loudColor) : [1, 0.47, 0, 1];
        const bw = w / BARS, phase = this._phase;
        const grow = 1 - (1 - phase) ** 3;                  // ease-out: the new bar grows in
        const bars = this._queue.length ? [...this._levels, this._queue[0] * grow] : this._levels;
        cr.rectangle(0, 0, w, h);
        cr.clip();
        bars.forEach((v, i) => {
            const x = (i - phase) * bw + bw * 0.25;
            if (x + bw * 0.5 < 0 || x > w)
                return;
            const bh = Math.max(4, v * (h - 2));
            if (v > 0.92)
                cr.setSourceRGBA(...loud);
            else                                            // fades in smoothly instead of a jump at a threshold
                cr.setSourceRGBA(fr, fg, fb, fa * (0.3 + 0.6 * Math.min(1, v / 0.25)));
            const bwi = bw * 0.5, y = (h - bh) / 2, r = Math.min(bwi / 2, bh / 2);
            cr.newSubPath();
            cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
            cr.arc(x + bwi - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
            cr.arc(x + bwi - r, y + bh - r, r, 0, 0.5 * Math.PI);
            cr.arc(x + r, y + bh - r, r, 0.5 * Math.PI, Math.PI);
            cr.closePath();
            cr.fill();
        });
        cr.$dispose();
    }

    // libadwaita-like spinner: a faint ring and an accent-coloured arc (the actor itself rotates)
    _drawSpinner(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const [r, g, b, a] = rgba(area.get_theme_node().get_foreground_color());
        const lw = 3, rad = Math.min(w, h) / 2 - lw;
        cr.setLineWidth(lw);
        cr.setLineCap(1);               // round
        cr.setSourceRGBA(r, g, b, a * 0.2);
        cr.arc(w / 2, h / 2, rad, 0, 2 * Math.PI);
        cr.stroke();
        cr.setSourceRGBA(r, g, b, a);
        cr.arc(w / 2, h / 2, rad, -0.5 * Math.PI, 0.9 * Math.PI);
        cr.stroke();
        cr.$dispose();
    }

    _later(ms, fn) {
        this._timers ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    // timers for actions (Caps off, paste, timeouts): not cancelled by UI changes, only by disable()
    _act(ms, fn) {
        this._acts ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._acts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._acts.add(id);
        return id;
    }

    // an action after everything of higher priority, the Shell's own idles included
    _idle(fn) {
        this._acts ??= new Set();
        const id = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._acts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._acts.add(id);
        return id;
    }

    _unact(id) {
        if (this._acts?.delete(id))
            GLib.source_remove(id);
    }

    _clearTimers() {
        this._stopWave();
        if (this._pulse)
            GLib.source_remove(this._pulse);
        this._pulse = null;
        for (const id of this._timers ?? [])
            GLib.source_remove(id);
        this._timers?.clear();
    }
}
