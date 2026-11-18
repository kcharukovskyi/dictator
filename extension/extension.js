// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2025-2026 The Dictator authors (see AUTHORS)
// Dictator: offline voice dictation. This file keeps the settings files in memory (SettingsCache in
// keys.js: read asynchronously, again whenever one changes, so a change applies at once) and grabs the
// start shortcut(s) from ~/.config/dictate/keys; a shortcut that cannot be grabbed (taken by GNOME or
// another app) is reported in a notification. Everything else is in core.js.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {readKeys, prettyAccel, gnomeShortcuts, takenBy, SettingsCache, DEFAULTS, KEYS_FILE} from './keys.js';
import {Core} from './core.js';

export default class Dictator extends Extension {
    enable() {
        this._grabs = new Map();
        this._startKeys = null;
        this._accelId = 0;
        this._locked = !!Main.sessionMode.isLocked;
        if (!this._locked)
            this._connectKeys();
        this._sessionId = Main.sessionMode.connect('updated', () => this._onSession());
        this._settings = new SettingsCache(path => this._onSettings(path));
        this._settings.start();
        this._core = new Core({openPrefs: () => this.openPreferences()});
        this._core.enable();
    }

    // This extension also runs in the "unlock-dialog" session mode (metadata.json), so that locking the
    // screen in the middle of a recording does not lose it: the recording is finished and transcribed,
    // and the text waits in the menu until the unlock. While locked, every keyboard signal and shortcut
    // grab is disconnected (here and in core.js) and nothing is shown or typed. disable() always
    // releases everything, whatever the session mode.
    disable() {
        if (this._sessionId)
            Main.sessionMode.disconnect(this._sessionId);
        this._sessionId = null;
        if (this._regrabId)
            GLib.source_remove(this._regrabId);
        this._regrabId = 0;
        this._disconnectKeys();
        this._core?.disable();
        this._core = null;
        this._settings?.stop();
        this._settings = null;
    }

    // screen locked: no keyboard signals or grabs at all; back after the unlock
    _onSession() {
        const locked = !!Main.sessionMode.isLocked;
        if (locked === this._locked)
            return;
        this._locked = locked;
        if (locked)
            this._disconnectKeys();
        else
            this._connectKeys();
    }

    _connectKeys() {
        if (!this._accelId)
            this._accelId = global.display.connect('accelerator-activated', (d, action) => this._grabs.get(action)?.());
        this._startKeys = null;                 // grab again
        this._grabStart();
    }

    _disconnectKeys() {
        if (this._accelId)
            global.display.disconnect(this._accelId);
        this._accelId = 0;
        this._ungrabAll();
        this._startKeys = null;
    }

    // (re)grab the start shortcut(s) from the keys file, if they changed
    _grabStart() {
        if (this._locked || !this._accelId || !this._settings?.has(KEYS_FILE))
            return;                     // not yet: the keys file is still being read
        const list = readKeys().start;
        const sig = JSON.stringify(list);
        if (sig === this._startKeys)
            return;
        this._startKeys = sig;
        this._ungrabAll();
        const taken = gnomeShortcuts();
        const bad = [];
        let ok = 0;
        for (const accel of list) {
            const by = takenBy(accel, taken);     // GNOME would silently keep the key for itself
            if (by)
                bad.push(`${prettyAccel(accel)} (used by ${by})`);
            else if (this._grab(accel, () => this._onChord()))
                ok++;
            else
                bad.push(prettyAccel(accel));
        }
        let instead = '';                       // never leave you without a way to start
        if (!ok && !takenBy(DEFAULTS.start, taken) && this._grab(DEFAULTS.start, () => this._onChord()))
            instead = ` For now ${prettyAccel(DEFAULTS.start)} starts it.`;
        if (bad.length) {
            Main.notify('Dictator', `Cannot use ${bad.join(', ')}.${instead} ` +
                'Choose another shortcut: microphone menu → Settings.');
        }
    }

    // a settings file was read (at start, or after a change): the keys may be new
    _onSettings(path) {
        if (path !== KEYS_FILE)
            return;
        if (this._regrabId)
            GLib.source_remove(this._regrabId);
        this._regrabId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._regrabId = 0;
            this._grabStart();
            return GLib.SOURCE_REMOVE;
        });
    }

    _grab(accel, fn) {
        const action = global.display.grab_accelerator(accel, Meta.KeyBindingFlags.NONE);
        if (action === Meta.KeyBindingAction.NONE) {
            console.warn(`dictator: cannot grab ${accel} (wrong name, or taken by another shortcut)`);
            return false;
        }
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
        this._grabs.set(action, fn);
        return true;
    }

    _ungrabAll() {
        for (const action of this._grabs.keys()) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE);
        }
        this._grabs.clear();
    }

    _onChord() {
        this._core?.chord();
    }
}
