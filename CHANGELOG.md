# Changelog

## Unreleased

- Long dictation is transcribed while you speak: the helper cuts the recording at pauses into pieces
  of 10 to 30 seconds and sends each one to the already loaded model in the background. The text is
  ready about a second after you stop, however long you spoke (90 s of speech: 0.7 s instead of
  6.4 s). Pieces with no voice are skipped. The language is still chosen once, over the whole
  recording. Retry uses the same pieces.
- The recording indicator can be dragged with the mouse. Its place is remembered
  (`~/.config/dictate/pill`); a double-click, or choosing a position in Settings, puts it back.
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
