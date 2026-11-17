# Changelog

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
