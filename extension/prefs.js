// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2025-2026 The Dictator authors (see AUTHORS)
// Settings window. Opens from the top-bar microphone menu ("Settings") or with:
// gnome-extensions prefs <uuid>. Two pages:
//   General  keys (~/.config/dictate/keys: the extension watches it and applies a change at once;
//            shortcuts GNOME already owns are refused) and privacy (~/.config/dictate/privacy)
//   Speech   languages, text, performance (~/.config/dictate/speech, replacements); see keys.js
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {readKeys, writeKeys, readPrivacy, writePrivacy, readSpeech, writeSpeech, ensureReplacements,
    prettyAccel, gnomeShortcuts, LANGUAGES, CAPS, NONE, SAME, DEFAULTS} from './keys.js';

const THREAD_CHOICES = [[0, 'Automatic'], [1, '1'], [2, '2'], [4, '4'], [6, '6'], [8, '8']];
const STOP_CHOICES = [[0, 'Off'], [2, 'After 2 seconds'], [3, 'After 3 seconds'], [5, 'After 5 seconds'],
    [10, 'After 10 seconds']];
const GATE_CHOICES = [['off', 'Off'], ['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']];
const PILL_CHOICES = [['bottom', 'Bottom'], ['top', 'Top']];

// [[source name, description]] of the real microphones (not monitors of outputs), from PipeWire
function microphones() {
    try {
        const proc = Gio.Subprocess.new(['pactl', '-f', 'json', 'list', 'sources'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [, out] = proc.communicate_utf8(null, null);
        return JSON.parse(out).filter(src => src.name && !src.name.endsWith('.monitor') && !src.monitor_source)
            .map(src => [src.name, src.description || src.name]);
    } catch (e) {
        return [];
    }
}

// a ComboRow over [[value, label], ...]; an unknown current value is shown as-is at the end
function choiceRow(props, choices, current, onChange) {
    const row = new Adw.ComboRow({...props, model: Gtk.StringList.new(choices.map(([, l]) => l))});
    const list = [...choices];
    let i = list.findIndex(([v]) => v === current);
    if (i < 0) {
        list.push([current, String(current)]);
        row.model.append(String(current));
        i = list.length - 1;
    }
    row.selected = i;
    row.connect('notify::selected', () => onChange(list[row.selected]?.[0] ?? current));
    return row;
}
const REPO = 'https://github.com/kcharukovskyi/dictator';

// how long kept recordings stay (minutes; 0 = until a restart)
const KEEP_CHOICES = [[15, '15 minutes'], [60, '1 hour'], [480, '8 hours'], [0, 'Until a restart']];

const ROWS = [
    {id: 'start', title: 'Start', hint: 'Starts recording'},
    {id: 'finish', title: 'Finish and Paste', hint: 'While recording (Enter also means the keypad Enter)', canSame: true},
    {id: 'pause', title: 'Pause / Resume', hint: 'While recording', canOff: true, caps: true},
    {id: 'cancel', title: 'Cancel', hint: 'While recording', canOff: true},
];
// keys that may be a global shortcut on their own (they type nothing); others need Ctrl, Alt or Super
const BARE_OK = /^(F\d{1,2}|Pause|Scroll_Lock|Insert|Menu|Print|XF86\w+)$/;
const MODIFIER_KEY = /^((Shift|Control|Alt|Meta|Super|Hyper)_[LR]|ISO_Level\d_(Shift|Latch|Lock)|Num_Lock|ISO_Next_Group)$/;
function parse(accel) {
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok && key ? [key, mods] : null;
}

function same(a, b) {
    if (a === b)
        return true;
    const pa = parse(a), pb = parse(b);
    return !!pa && !!pb && pa[0] === pb[0] && pa[1] === pb[1];
}

export default class DictatorPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(640, 640);
        window.set_search_enabled(true);
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcuts',
            description: 'Applied at once, no need to log out. Saved in ~/.config/dictate/keys (you can edit it by hand too).',
        });
        page.add(group);
        window.add(page);
        const taken = gnomeShortcuts();
        const ui = {};

        const refresh = () => {
            const keys = readKeys();
            for (const r of ROWS) {
                const v = r.id === 'start' ? keys.start[0] : keys[r.id];
                const u = ui[r.id];
                const real = v !== CAPS && v !== NONE && v !== SAME && !!parse(v);
                u.accel.visible = real;
                u.accel.accelerator = real ? v : '';
                u.text.visible = !real;
                u.text.label = v === CAPS ? 'Caps Lock' : v === NONE ? 'Off'
                    : v === SAME ? `${prettyAccel(keys.start[0])} again` : v;
                const notes = [r.hint];
                if (r.id === 'start' && keys.start.length > 1)
                    notes.push(`Also (from the file): ${keys.start.slice(1).join(', ')}`);
                const clash = real && taken.find(([a]) => same(a, v));
                if (clash)
                    notes.push(`⚠ Already used by ${clash[1]}: will not work, choose another`);
                u.row.subtitle = notes.join('\n');
                u.reset.sensitive = v !== DEFAULTS[r.id];
            }
        };

        // save one key; returns an error text or null
        const set = (id, value) => {
            const keys = readKeys();
            if (value !== NONE && value !== SAME) {
                for (const o of ROWS) {
                    if (o.id === id)
                        continue;
                    const used = o.id === 'start' ? keys.start : [keys[o.id]];
                    if (used.some(x => x !== NONE && x !== SAME && same(x, value)))
                        return `Already used for “${o.title}”. One key, one job.`;
                }
            }
            if (value !== NONE && value !== SAME && value !== CAPS) {
                const clash = taken.find(([a]) => same(a, value));
                if (clash)
                    return `${prettyAccel(value)} is already used by ${clash[1]}: it would never reach dictation. Choose another one.`;
            }
            if (id === 'start')
                keys.start[0] = value;
            else
                keys[id] = value;
            try {
                writeKeys(keys);
            } catch (e) {
                return `Cannot save: ${e.message}`;
            }
            refresh();
            return null;
        };

        for (const r of ROWS) {
            const row = new Adw.ActionRow({title: r.title, subtitle: r.hint});
            const accel = new Gtk.ShortcutLabel({valign: Gtk.Align.CENTER});
            const text = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['dim-label']});
            const change = new Gtk.Button({label: 'Change…', valign: Gtk.Align.CENTER});
            const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: 'Back to the default', css_classes: ['flat']});
            change.connect('clicked', () => this._capture(window, r, set));
            reset.connect('clicked', () => set(r.id, DEFAULTS[r.id]));
            for (const w of [accel, text, change, reset])
                row.add_suffix(w);
            row.activatable_widget = change;
            group.add(row);
            ui[r.id] = {row, accel, text, reset};
        }
        refresh();
        page.add(this._privacyGroup());
        page.add(this._appearanceGroup());
        page.add(this._aboutGroup());
        window.add(this._speechPage());
    }

    _appearanceGroup() {
        const group = new Adw.PreferencesGroup({title: 'Appearance'});
        const sp = readSpeech();
        group.add(choiceRow({title: 'Indicator Position', subtitle: 'Where the recording indicator appears'},
            PILL_CHOICES, sp.pill, v => writeSpeech({...readSpeech(), pill: v})));
        return group;
    }

    // footer: who made it
    _aboutGroup() {
        const group = new Adw.PreferencesGroup();
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 12,
            halign: Gtk.Align.CENTER});
        box.append(new Gtk.Label({label: 'Proudly made in Ukraine 🇺🇦', css_classes: ['heading']}));
        box.append(new Gtk.LinkButton({uri: REPO, label: 'Project Page', halign: Gtk.Align.CENTER}));
        group.add(box);
        return group;
    }

    _speechPage() {
        const page = new Adw.PreferencesPage({title: 'Speech', icon_name: 'audio-input-microphone-symbolic'});
        const sp = readSpeech();
        // the General page writes the indicator position into the same file: keep what is there
        const save = () => writeSpeech({...sp, pill: readSpeech().pill});

        // languages: the main one first, then the others in the table's order
        const langs = new Adw.PreferencesGroup({title: 'Languages',
            description: 'Only the languages you turn on are recognised, so similar ones are not mixed up. ' +
                'Changes apply from the next recording.'});
        const names = new Map(LANGUAGES.map(([c, en, own]) => [c, en === own ? en : `${en} (${own})`]));
        const main = new Adw.ComboRow({title: 'Main Language',
            subtitle: 'Preferred when Ukrainian, Russian and Bulgarian are hard to tell apart'});
        const fillMain = () => {
            main.model = Gtk.StringList.new(sp.languages.map(c => names.get(c)));
            main.selected = 0;
        };
        fillMain();
        main.connect('notify::selected', () => {
            const c = sp.languages[main.selected];
            if (main.selected > 0 && c) {
                sp.languages = [c, ...sp.languages.filter(x => x !== c)];
                save();
                fillMain();
            }
        });
        langs.add(main);
        const list = new Adw.ExpanderRow({title: 'Enabled Languages'});
        const summary = () => {
            list.subtitle = sp.languages.map(c => names.get(c).split(' (')[0]).join(', ');
        };
        for (const [code] of LANGUAGES) {
            const row = new Adw.SwitchRow({title: names.get(code), active: sp.languages.includes(code)});
            row.connect('notify::active', () => {
                if (row.active && !sp.languages.includes(code)) {
                    sp.languages.push(code);
                } else if (!row.active && sp.languages.includes(code)) {
                    if (sp.languages.length === 1) {        // at least one language stays on
                        row.active = true;
                        return;
                    }
                    sp.languages = sp.languages.filter(x => x !== code);
                }
                save();
                fillMain();
                summary();
            });
            list.add_row(row);
        }
        summary();
        langs.add(list);
        page.add(langs);

        // text
        const text = new Adw.PreferencesGroup({title: 'Text'});
        const space = new Adw.SwitchRow({title: 'Space After the Text',
            subtitle: 'So that the next dictation does not stick to this one', active: sp.spaceAfter});
        space.connect('notify::active', () => {
            sp.spaceAfter = space.active;
            save();
        });
        const period = choiceRow({title: 'No Period at the End', subtitle: 'Chats read better without it'},
            [['keep', 'Never'], ['chats', 'In Chats and Terminals'], ['drop', 'Always']], sp.finalPeriod, v => {
                sp.finalPeriod = v;
                save();
            });
        const punct = new Adw.SwitchRow({title: 'Spoken Punctuation',
            subtitle: 'Say “кома”, “крапка”, “знак питання”, “новий рядок”, “comma”, “new line”… ' +
                '(Ukrainian, Russian, English). A new line is a space in a terminal',
            active: sp.spokenPunctuation});
        punct.connect('notify::active', () => {
            sp.spokenPunctuation = punct.active;
            save();
        });
        const fillers = new Adw.SwitchRow({title: 'Remove Hesitation Sounds',
            subtitle: '“еее”, “ммм”, “um”, “uh”', active: sp.fillers});
        fillers.connect('notify::active', () => {
            sp.fillers = fillers.active;
            save();
        });
        const repl = new Adw.ActionRow({title: 'Replacements and Snippets',
            subtitle: 'Fix words (“пайтон = Python”) or expand phrases (“мій імейл = me@example.com”)'});
        const edit = new Gtk.Button({label: 'Edit', valign: Gtk.Align.CENTER});
        edit.connect('clicked', () => {
            const file = Gio.File.new_for_path(ensureReplacements());
            Gio.AppInfo.launch_default_for_uri_async(file.get_uri(), null, null, (o, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                } catch (e) {
                    repl.subtitle = `Open it by hand: ${file.get_path()}`;
                }
            });
        });
        repl.add_suffix(edit);
        repl.activatable_widget = edit;
        for (const r of [punct, fillers, period, space, repl])
            text.add(r);
        page.add(text);

        // recording
        const rec = new Adw.PreferencesGroup({title: 'Recording'});
        const mics = [['default', 'System Default'], ...microphones().map(([n, d]) =>
            [n, d.replace(/ \(HD Audio\)| Family On-Package High Definition Audio/g, '')])];
        if (sp.microphone !== 'default' && !mics.some(([n]) => n === sp.microphone))
            mics.push([sp.microphone, 'Chosen microphone (not connected now)']);
        const mic = choiceRow({title: 'Microphone',
            subtitle: 'If the chosen one is not connected, the system default is used'},
        mics, sp.microphone, v => {
            sp.microphone = v;
            save();
        });
        rec.add(mic);
        rec.add(choiceRow({title: 'Stop on Silence', subtitle: 'Finish by itself when you stop talking'},
            STOP_CHOICES, sp.autoStop, v => {
                sp.autoStop = v;
                save();
            }));
        rec.add(choiceRow({title: 'Ignore Quieter Voices',
            subtitle: 'Mute sound much quieter than your voice: other people, a TV. Stronger works best with a headset'},
        GATE_CHOICES, sp.voiceGate, v => {
            sp.voiceGate = v;
            save();
        }));
        page.add(rec);

        // performance
        const perf = new Adw.PreferencesGroup({title: 'Performance'});
        const threads = new Adw.ComboRow({title: 'Processor Threads',
            subtitle: `More is not always faster; automatic uses up to 4 of ${GLib.get_num_processors()}`,
            model: Gtk.StringList.new(THREAD_CHOICES.map(([, l]) => l))});
        const ti = THREAD_CHOICES.findIndex(([n]) => n === sp.threads);
        if (ti >= 0) {
            threads.selected = ti;
        } else {
            threads.model.append(String(sp.threads));
            threads.selected = THREAD_CHOICES.length;
        }
        threads.connect('notify::selected', () => {
            sp.threads = THREAD_CHOICES[threads.selected]?.[0] ?? sp.threads;
            save();
        });
        perf.add(threads);
        page.add(perf);
        return page;
    }

    _privacyGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Privacy',
            description: 'Text is typed straight into the app, without the clipboard. Recordings stay in ' +
                'memory only, never on the disk, and are deleted after the time below.',
        });
        const p = readPrivacy();
        const history = new Adw.SwitchRow({title: 'Recent Texts in the Top Bar',
            subtitle: 'The last 3 texts in the microphone menu, to copy them',
            active: p.history});
        const clipboard = new Adw.SwitchRow({title: 'Paste Through the Clipboard',
            subtitle: 'For apps that cannot take typed text. Off: the text waits in the microphone menu, ' +
                'and other apps never see it in the clipboard',
            active: p.clipboard});
        const keep = new Adw.ComboRow({title: 'Delete Recordings After',
            model: Gtk.StringList.new(KEEP_CHOICES.map(([, label]) => label))});
        const idx = KEEP_CHOICES.findIndex(([m]) => m === p.keepMinutes);
        if (idx >= 0) {
            keep.selected = idx;
        } else {                    // a value set by hand in the file: show it as it is
            keep.model.append(`${p.keepMinutes} minutes`);
            keep.selected = KEEP_CHOICES.length;
        }
        const save = () => {
            const minutes = KEEP_CHOICES[keep.selected]?.[0] ?? readPrivacy().keepMinutes;
            writePrivacy({history: history.active, keepMinutes: minutes, clipboard: clipboard.active});
        };
        history.connect('notify::active', save);
        clipboard.connect('notify::active', save);
        keep.connect('notify::selected', save);
        group.add(clipboard);
        group.add(history);
        group.add(keep);
        return group;
    }

    // a small window that waits for the new shortcut
    _capture(parent, r, set) {
        const extra = [r.canOff ? 'Backspace: off' : null, r.canSame ? 'Backspace: the start shortcut again' : null, r.caps ? 'Caps Lock: use Caps Lock' : null]
            .filter(Boolean).join(', ');
        const hint = `Esc: keep the old one${extra ? `, ${extra}` : ''}`;
        const dlg = new Adw.Window({transient_for: parent, modal: true, default_width: 460, default_height: 280,
            title: r.title});
        const status = new Adw.StatusPage({icon_name: 'input-keyboard-symbolic',
            title: `Press the new shortcut for “${r.title}”`, description: hint});
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(new Adw.HeaderBar());
        box.append(status);
        dlg.set_content(box);
        const finish = value => {
            const err = set(r.id, value);
            if (err)
                status.description = `${err}\n${hint}`;
            else
                dlg.close();
            return Gdk.EVENT_STOP;
        };
        const refuse = msg => {
            status.description = `${msg}\n${hint}`;
            return Gdk.EVENT_STOP;
        };
        // capture phase: Enter / Space must reach this, not activate the window's close button
        const ctl = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        ctl.connect('key-pressed', (c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            const name = Gdk.keyval_name(keyval) ?? '';
            if (!mods && keyval === Gdk.KEY_Escape)
                return dlg.close() ?? Gdk.EVENT_STOP;
            if (!mods && keyval === Gdk.KEY_BackSpace && r.canOff)
                return finish(NONE);
            if (!mods && keyval === Gdk.KEY_BackSpace && r.canSame)
                return finish(SAME);
            if (keyval === Gdk.KEY_Caps_Lock)
                return r.caps ? finish(CAPS) : refuse('Caps Lock works only for Pause.');
            if (MODIFIER_KEY.test(name))
                return Gdk.EVENT_STOP;          // wait for the whole combination
            // the key without Shift applied: Shift+1 is <Shift>1, not <Shift>exclam
            let key = keyval;
            const [ok, base] = dlg.get_display().translate_key(keycode, 0, c.get_group());
            if (ok && base)
                key = base;
            key = Gdk.keyval_to_lower(key);
            if (key === Gdk.KEY_KP_Enter)       // both Enter keys work as "Return"
                key = Gdk.KEY_Return;
            const strong = mods & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK |
                Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.META_MASK | Gdk.ModifierType.HYPER_MASK);
            if (r.id === 'start' && !strong && !BARE_OK.test(Gdk.keyval_name(key) ?? ''))
                return refuse('Add Ctrl, Alt or Super: on its own this key would stop typing everywhere.');
            if (!Gtk.accelerator_valid(key, mods))
                return refuse('That is not a valid shortcut.');
            return finish(Gtk.accelerator_name(key, mods));
        });
        dlg.add_controller(ctl);
        // let the combination reach this window, not GNOME (e.g. the current dictation shortcut)
        dlg.connect('map', () => dlg.get_surface()?.inhibit_system_shortcuts?.(null));
        dlg.connect('unmap', () => dlg.get_surface()?.restore_system_shortcuts?.());
        dlg.present();
    }
}
