// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2025-2026 The Dictator authors (see AUTHORS)
// Dictation keys: ~/.config/dictate/keys, read by extension.js / core.js and written by prefs.js
// (the settings window). One line per key, "name = GNOME accelerator":
//   start   start a recording (the line can repeat: several shortcuts)
//   finish  while recording: finish it and paste the text (default Enter; also the keypad Enter);
//           start = the start shortcut again finishes it
//   pause   pause / resume while recording; CapsLock = the Caps Lock key (the lock itself is not
//           toggled); none = off
//   cancel  cancel while recording; none = off
// The extension watches the file: a change applies at once, no log out. Without the file: the start
// lines of the old ~/.config/dictate/shortcut, else the defaults.
// Also the privacy settings, ~/.config/dictate/privacy (read by the helper bin/dictate too):
//   history = on|off      keep the last 3 recordings (audio + text, RAM only) for the microphone menu
//   keep_minutes = N      delete kept recordings (history and failed ones) after N minutes; 0 = until restart
//   clipboard = on|off    paste through the clipboard into apps that cannot take typed text (default off:
//                         the clipboard is never used, such text waits in the microphone menu)
// Imports only GLib / Gio: also loaded by the settings window, which runs outside GNOME Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'dictate']);
export const KEYS_FILE = GLib.build_filenamev([DIR, 'keys']);
export const OLD_FILE = GLib.build_filenamev([DIR, 'shortcut']);
export const CAPS = 'CapsLock';
export const NONE = 'none';
export const SAME = 'start';            // finish = the start shortcut again
export const DEFAULTS = Object.freeze({start: '<Control><Alt>space', finish: 'Return', pause: CAPS, cancel: 'Escape'});

const HEADER = `# Dictator keys. Easiest to change in the settings window: top-bar microphone menu ->
# "Settings...", or: gnome-extensions prefs <extension uuid>
# By hand: name = GNOME accelerator, e.g. <Control><Alt>space  <Super>d  <Control><Shift>d  F9  Pause
#   start   start a recording (repeat the line for more shortcuts)
#   finish  while recording: finish and paste (Return = Enter); start = the start shortcut again
#   pause   pause / resume while recording; CapsLock = Caps Lock (the lock is not toggled); none = off
#   cancel  cancel while recording; none = off
# Applies at once, no log out. A shortcut that GNOME or another app already uses does not work.
`;

function load(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

export function readKeys() {
    const keys = {start: [], finish: DEFAULTS.finish, pause: DEFAULTS.pause, cancel: DEFAULTS.cancel};
    const text = load(KEYS_FILE);
    if (text !== null) {
        for (const line of text.split('\n')) {
            const m = line.trim().match(/^(start|finish|pause|cancel)\s*=\s*(\S+)$/);
            if (!m)
                continue;
            if (m[1] !== 'start')
                keys[m[1]] = m[2];
            else if (m[2] !== NONE && !keys.start.includes(m[2]))
                keys.start.push(m[2]);
        }
    } else {
        keys.start = (load(OLD_FILE) ?? '').split('\n').map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    }
    if (!keys.start.length)
        keys.start = [DEFAULTS.start];
    if (keys.finish === NONE)               // there must be a way to finish
        keys.finish = DEFAULTS.finish;
    return keys;
}

export function writeKeys(keys) {
    GLib.mkdir_with_parents(DIR, 0o700);
    const lines = [...keys.start.map(a => `start = ${a}`), `finish = ${keys.finish}`, `pause = ${keys.pause}`,
        `cancel = ${keys.cancel}`];
    GLib.file_set_contents(KEYS_FILE, `${HEADER}${lines.join('\n')}\n`);
}

// GNOME's own shortcuts (and IBus's) always win over an extension's, silently: the extension "grabs"
// the combination without an error, but never gets the key. So a clash is checked here, by name.
const SCHEMAS = ['org.gnome.desktop.wm.keybindings', 'org.gnome.shell.keybindings', 'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings', 'org.gnome.settings-daemon.plugins.media-keys',
    'org.freedesktop.ibus.general.hotkey'];
const CUSTOM = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

// "<Primary><Alt>Space" and "<Alt><Control>space" are the same shortcut
export function normAccel(a) {
    const alias = {primary: 'control', ctrl: 'control', ctl: 'control', mod1: 'alt', mod4: 'super'};
    const mods = new Set();
    const key = a.replace(/<([^>]+)>/g, (m, n) => {
        mods.add(alias[n.toLowerCase()] ?? n.toLowerCase());
        return '';
    });
    return `${[...mods].sort().join('+')}|${key.toLowerCase()}`;
}

// [[accelerator, what uses it], ...]
export function gnomeShortcuts() {
    const out = [];
    const src = Gio.SettingsSchemaSource.get_default();
    const nice = k => k.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
    for (const id of SCHEMAS) {
        const schema = src?.lookup(id, true);
        if (!schema)
            continue;
        const s = new Gio.Settings({settings_schema: schema});
        for (const k of schema.list_keys()) {
            if (k === 'custom-keybindings' || schema.get_key(k).get_value_type().dup_string() !== 'as')
                continue;
            for (const a of s.get_strv(k))
                out.push([a, `${id.includes('ibus') ? 'IBus' : 'GNOME'} (“${nice(k)}”)`]);
        }
        const custom = src.lookup(CUSTOM, true);
        if (id.endsWith('media-keys') && custom) {
            for (const path of s.get_strv('custom-keybindings')) {
                const c = new Gio.Settings({settings_schema: custom, path});
                out.push([c.get_string('binding'), `your custom shortcut “${c.get_string('name')}”`]);
            }
        }
    }
    return out;
}

// what already uses this shortcut, or null
export function takenBy(accel, list = gnomeShortcuts()) {
    const n = normAccel(accel);
    return list.find(([a]) => a && normAccel(a) === n)?.[1] ?? null;
}

export const PRIVACY_FILE = GLib.build_filenamev([DIR, 'privacy']);
export const PRIVACY_DEFAULTS = Object.freeze({history: true, keepMinutes: 60, clipboard: false});

export function readPrivacy() {
    const p = {...PRIVACY_DEFAULTS};
    for (const line of (load(PRIVACY_FILE) ?? '').split('\n')) {
        const m = line.trim().match(/^(history|keep_minutes|clipboard)\s*=\s*(\S+)$/);
        if (m?.[1] === 'history')
            p.history = m[2] !== 'off';
        else if (m?.[1] === 'clipboard')
            p.clipboard = m[2] === 'on';
        else if (m && /^\d+$/.test(m[2]))
            p.keepMinutes = parseInt(m[2]);
    }
    return p;
}

export function writePrivacy(p) {
    GLib.mkdir_with_parents(DIR, 0o700);
    GLib.file_set_contents(PRIVACY_FILE,
        '# Dictator privacy (settings window: microphone menu -> "Settings...").\n' +
        '# history = on|off: keep the last 3 recordings (audio + text, in RAM only) for the microphone menu\n' +
        '# keep_minutes = N: delete kept recordings (also failed ones) after N minutes; 0 = until restart\n' +
        '# clipboard = on|off: apps that cannot take typed text get it by a paste through the clipboard;\n' +
        '#   off: the clipboard is never used, the text waits in the microphone menu\n' +
        `history = ${p.history ? 'on' : 'off'}\nkeep_minutes = ${p.keepMinutes}\n` +
        `clipboard = ${p.clipboard ? 'on' : 'off'}\n`);
}

// Speech settings, ~/.config/dictate/speech (read by the helper bin/dictate too):
//   languages = uk en ru     enabled languages, main first     margin = 0.15 (see lib/parakeet.py)
//   threads = 0 (automatic)  final_period = keep|drop          space_after = on|off
//   microphone = default|<source name>   auto_stop = 0 (seconds of silence)   pill = bottom|top
//   voice_gate = off|light|medium|strong (mute sound much quieter than your voice)
//   final_period = keep|drop|chats   spoken_punctuation = off|on   fillers = on|off
// and ~/.config/dictate/replacements: "words = replacement" per line.
export const SPEECH_FILE = GLib.build_filenamev([DIR, 'speech']);
export const REPLACE_FILE = GLib.build_filenamev([DIR, 'replacements']);
// the speech model's 25 languages: [code, English name, own name]
export const LANGUAGES = Object.freeze([
    ['uk', 'Ukrainian', 'Українська'], ['en', 'English', 'English'], ['bg', 'Bulgarian', 'Български'],
    ['hr', 'Croatian', 'Hrvatski'], ['cs', 'Czech', 'Čeština'], ['da', 'Danish', 'Dansk'],
    ['nl', 'Dutch', 'Nederlands'], ['et', 'Estonian', 'Eesti'], ['fi', 'Finnish', 'Suomi'],
    ['fr', 'French', 'Français'], ['de', 'German', 'Deutsch'], ['el', 'Greek', 'Ελληνικά'],
    ['hu', 'Hungarian', 'Magyar'], ['it', 'Italian', 'Italiano'], ['lv', 'Latvian', 'Latviešu'],
    ['lt', 'Lithuanian', 'Lietuvių'], ['mt', 'Maltese', 'Malti'], ['pl', 'Polish', 'Polski'],
    ['pt', 'Portuguese', 'Português'], ['ro', 'Romanian', 'Română'], ['ru', 'Russian', 'Русский'],
    ['sk', 'Slovak', 'Slovenčina'], ['sl', 'Slovenian', 'Slovenščina'], ['es', 'Spanish', 'Español'],
    ['sv', 'Swedish', 'Svenska'],
]);
export const SPEECH_DEFAULTS = Object.freeze({languages: ['uk', 'en', 'ru'], margin: 0.15, threads: 0,
    finalPeriod: 'keep', spaceAfter: false, microphone: 'default', autoStop: 0, voiceGate: 'off', pill: 'bottom',
    spokenPunctuation: false, fillers: true});
// a line break the user dictated ("новий рядок"): the helper sends this private-use character, the
// extension types a line break, or a space in a terminal (there a line break would run a command)
export const NEWLINE_MARK = '\ue000';

export function readSpeech() {
    const p = {...SPEECH_DEFAULTS, languages: [...SPEECH_DEFAULTS.languages]};
    const codes = new Set(LANGUAGES.map(([c]) => c));
    for (const line of (load(SPEECH_FILE) ?? '').split('\n')) {
        const m = line.trim().match(
            /^(languages|margin|threads|final_period|space_after|microphone|auto_stop|voice_gate|pill|spoken_punctuation|fillers)\s*=\s*(.*)$/);
        if (!m)
            continue;
        const v = m[2].trim();
        if (m[1] === 'languages') {
            const l = [...new Set(v.split(/[\s,]+/).filter(c => codes.has(c)))];
            if (l.length)
                p.languages = l;
        } else if (m[1] === 'margin' && Number.isFinite(parseFloat(v))) {
            p.margin = Math.min(2, Math.max(0, parseFloat(v)));
        } else if (m[1] === 'threads' && /^\d+$/.test(v)) {
            p.threads = Math.min(64, parseInt(v));
        } else if (m[1] === 'final_period' && ['keep', 'drop', 'chats'].includes(v)) {
            p.finalPeriod = v;
        } else if (m[1] === 'space_after') {
            p.spaceAfter = v === 'on';
        } else if (m[1] === 'microphone' && /^[\w.:@+-]+$/.test(v)) {
            p.microphone = v;
        } else if (m[1] === 'auto_stop' && /^\d+$/.test(v)) {
            p.autoStop = Math.min(60, parseInt(v));
        } else if (m[1] === 'voice_gate' && ['off', 'light', 'medium', 'strong'].includes(v)) {
            p.voiceGate = v;
        } else if (m[1] === 'pill' && ['bottom', 'top'].includes(v)) {
            p.pill = v;
        } else if (m[1] === 'spoken_punctuation') {
            p.spokenPunctuation = v === 'on';
        } else if (m[1] === 'fillers') {
            p.fillers = v !== 'off';
        }
    }
    return p;
}

export function writeSpeech(p) {
    GLib.mkdir_with_parents(DIR, 0o700);
    GLib.file_set_contents(SPEECH_FILE,
        '# Dictator speech settings (settings window: microphone menu -> "Settings", page "Speech").\n' +
        '# languages: enabled, main first (codes: ' + LANGUAGES.map(([c]) => c).join(' ') + ')\n' +
        '# margin: how much surer another Cyrillic language must be than the main one (0.15)\n' +
        '# threads: CPU threads for the model, 0 = automatic; final_period: keep|drop|chats; space_after: on|off\n' +
        '# spoken_punctuation: on|off ("кома", "знак питання", "новий рядок"...); fillers: on|off (remove "еее", "um")\n' +
        '# microphone: default or a source name (pactl list short sources); auto_stop: seconds of silence, 0 = off\n' +
        '# voice_gate: off|light|medium|strong (mute sound much quieter than your voice); pill: bottom|top\n' +
        `languages = ${p.languages.join(' ')}\nmargin = ${p.margin}\nthreads = ${p.threads}\n` +
        `final_period = ${p.finalPeriod}\nspace_after = ${p.spaceAfter ? 'on' : 'off'}\n` +
        `microphone = ${p.microphone}\nauto_stop = ${p.autoStop}\nvoice_gate = ${p.voiceGate}\npill = ${p.pill}\n` +
        `spoken_punctuation = ${p.spokenPunctuation ? 'on' : 'off'}\nfillers = ${p.fillers ? 'on' : 'off'}\n`);
}

// the replacements file, created with an explanation the first time
export function ensureReplacements() {
    if (GLib.file_test(REPLACE_FILE, GLib.FileTest.EXISTS))
        return REPLACE_FILE;
    GLib.mkdir_with_parents(DIR, 0o700);
    GLib.file_set_contents(REPLACE_FILE,
        '# Dictator word replacements and snippets: one per line, "what you say = what is typed".\n' +
        '# Whole words only (so word forms need their own lines), upper/lower case does not matter.\n' +
        '# Examples:\n# пайтон = Python\n# гіт хаб = GitHub\n# мій імейл = me@example.com\n' +
        '# моє посилання = https://example.com/me\n');
    return REPLACE_FILE;
}

// Speech gives one line of words: control characters (line breaks, ESC sequences), zero-width and
// bidi-override characters cannot come from it and are cut (the helper does it too), so even a
// tampered model cannot make a paste run a command in a terminal or hide text.
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const MAX_TEXT = 50000;

export function cleanText(t) {
    return typeof t === 'string' ? t.replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
}

// "<Control><Alt>space" -> "Ctrl+Alt+Space" (for messages on screen)
export function prettyAccel(a) {
    if (a === CAPS)
        return 'Caps Lock';
    if (a === NONE)
        return 'off';
    const mods = {control: 'Ctrl', primary: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', super: 'Super', shift: 'Shift',
        meta: 'Meta', hyper: 'Hyper'};
    const names = {Return: 'Enter', KP_Enter: 'Enter', Escape: 'Esc', Caps_Lock: 'Caps Lock', BackSpace: 'Backspace'};
    const key = a.replace(/<([^>]+)>/g, (m, n) => `${mods[n.toLowerCase()] ?? n}+`);
    return key.replace(/[^+]+$/, k => names[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)));
}
