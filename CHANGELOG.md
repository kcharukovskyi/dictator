# Changelog

## Unreleased

- A long text no longer closes the app it is typed into. The input method hands an app the whole
  text as one Wayland message, and an app drops its connection on a message over 4096 bytes (about
  2000 Cyrillic letters or 4000 Latin ones): kitty and GTK windows closed at once after a
  dictation of several minutes. The text is now typed in parts of at most 2000 bytes, cut after a
  space, one after another; if you switch windows meanwhile, the rest is typed nowhere and the whole
  text waits in the microphone menu.
- Settings → Speech → Speech Model → **Try Dictation**: record a sentence and see the text right
  there, typed nowhere and kept nowhere (`dictate --try`). Without the helper, the settings window
  shows the install command, ready to select and copy.
- The recording indicator shows the icon of the app the text will go to, while you speak and while
  it is transcribed.
- Microphones are found with `pw-dump` (pipewire-utils) instead of `pactl`, which PipeWire-only
  systems do not install.
- In GNOME Shell the settings files are read asynchronously and kept in memory (no synchronous file
  IO in the Shell); the start shortcut is grabbed once the keys file is read.
- A GitHub Actions check on every push: shellcheck, Python, JavaScript syntax, and the extension
  package against the extensions.gnome.org rules (shexli).
- Long dictation is transcribed while you speak: the helper cuts the recording at pauses into pieces
  of 10 to 30 seconds and sends each one to the already loaded model in the background. The text is
  ready about a second after you stop, however long you spoke (90 s of speech: 0.7 s instead of
  6.4 s). Pieces with no voice are skipped. The language is still chosen once, over the whole
  recording. Retry uses the same pieces.
- The recording indicator can be dragged with the mouse. Its place is remembered
  (`~/.config/dictate/pill`); a double-click, or choosing a position in Settings, puts it back.
- Transcribe Again: with "Keep Audio to Transcribe Again" on (Settings, Privacy; off by default) the
  last three recordings stay in RAM, and the menu can transcribe one again, as it was or in a
  language you choose in Settings (`dictate --redo`). The new text replaces the old one and is copied.
- Choosing between Cyrillic languages depends on the pair: Russian must be 0.45/s surer on top of
  the margin before it replaces Ukrainian, because the model leans to Russian on Ukrainian speech
  (measured up to +0.52/s). Other pairs use the margin alone.
- Finish key: Shift+Caps Lock can finish a recording (the lock is not toggled), and pressing a start
  shortcut in the "Finish and Paste" dialog makes the start shortcut finish too.

## 1.0.0 (unreleased): first public release

- The helper program (`helper/`), `install.sh` and `uninstall.sh` are in the repository.
- Speech model: download from the settings window (Settings → Speech → Speech Model), with progress,
  cancel and resume. Two variants: Standard (8-bit, made on your computer from NVIDIA's model and
  byte-identical to the reference build) and Full Precision (32-bit). Every file is checked against
  a pinned SHA-256. This replaces the old `model.sh`, which downloaded about 5 GB.
- The history keeps texts only. The audio of a transcribed recording is deleted at once.
- The extension says so, and links to the instructions, when the helper or the model is missing.
- Cleanup for extensions.gnome.org:
  - all timeouts are removed in `disable()`;
  - per-dictation notes are debug messages;
  - the clipboard use is declared in the description;
  - dead code for older GNOME versions is gone.
- License: GPL-3.0-or-later (was GPL-2.0-or-later).
