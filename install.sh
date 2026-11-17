#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2025-2026 The Dictator authors (see AUTHORS)
# Installs Dictator for this user only (no sudo):
#   ~/.local/bin/dictate, ~/.local/lib/dictate/parakeet.py      the helper program
#   ~/.local/share/gnome-shell/extensions/<uuid>/                the GNOME extension
#   ~/.local/share/dictate/parakeet-tdt-0.6b-v3/                  the speech model (optional, asked)
# Options: --no-extension (you installed the extension from extensions.gnome.org), --yes (no questions)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
UUID=dictator@kcharukovskyi.github.io
EXT=$HOME/.local/share/gnome-shell/extensions/$UUID
CONF=$HOME/.config/dictate
BIN=$HOME/.local/bin/dictate
# the interpreter the helper runs with (its first line); GNOME starts it without your conda/venv
PY=/usr/bin/python3
WITH_EXT=1 YES=0
for a in "$@"; do
  case $a in
    --no-extension) WITH_EXT=0 ;;
    --yes|-y) YES=1 ;;
    *) echo "Unknown option: $a"; exit 2 ;;
  esac
done
say() { printf '\n== %s\n' "$*"; }
ask() {   # ask "question" default(y|n)
  local a
  if [ "$YES" = 1 ]; then return 0; fi
  read -r -p "$1 $([ "$2" = y ] && echo '[Y/n]' || echo '[y/N]') " a
  a=${a:-$2}
  [[ $a == [yY]* ]]
}

# shellcheck source=/dev/null
. /etc/os-release 2>/dev/null || true
FAMILY=other
case " ${ID:-} ${ID_LIKE:-} " in
  *" fedora "*|*" rhel "*) FAMILY=fedora ;;
  *" ubuntu "*|*" debian "*) FAMILY=debian ;;
  *" arch "*) FAMILY=arch ;;
  *" opensuse"*|*" suse "*) FAMILY=suse ;;
esac
pkg() {   # pkg <fedora> <debian> <arch> <suse>: the install command for this distribution
  case $FAMILY in
    fedora) echo "sudo dnf install $1" ;;
    debian) echo "sudo apt install $2" ;;
    arch) echo "sudo pacman -S $3" ;;
    suse) echo "sudo zypper install $4" ;;
    *) echo "your package manager: $2 (Debian names)" ;;
  esac
}

say "1/5 Checking the system"
if command -v gnome-shell >/dev/null; then
  v=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
  tested=$(tr -d '\n' < "$HERE/extension/metadata.json" | grep -oE '"shell-version"[^]]*' | grep -oE '[0-9]+' | paste -sd ' ')
  echo "GNOME Shell $v"
  [[ " $tested " == *" $v "* ]] || echo "WARNING: the extension is made for GNOME $tested; GNOME $v will not load it."
else
  echo "WARNING: GNOME Shell not found. Dictator is a GNOME extension."
fi
missing=()
command -v pw-record >/dev/null || missing+=("pw-record: $(pkg pipewire-utils pipewire-bin pipewire pipewire-tools)")
command -v pactl >/dev/null || missing+=("pactl: $(pkg pulseaudio-utils pulseaudio-utils libpulse pulseaudio-utils)")
[ -x "$PY" ] || missing+=("$PY: $(pkg python3 python3 python python3)")
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing programs:"; printf '  %s\n' "${missing[@]}"
  echo "Install them, then run ./install.sh again."
  exit 1
fi
echo OK

say "2/5 Where the speech model runs"
mkdir -p "$CONF"
if "$PY" -I -c 'import onnxruntime, numpy' 2>/dev/null; then
  echo host > "$CONF/runtime"
  echo "System Python has onnxruntime and numpy: the model runs with them."
  if command -v bwrap >/dev/null; then
    echo "Sandbox: bubblewrap (no network, no access to your files)."
  else
    echo "Sandbox: unshare (no network only). For full isolation: $(pkg bubblewrap bubblewrap bubblewrap bubblewrap)"
  fi
  "$PY" -I -c 'import onnx' 2>/dev/null ||
    echo "Note: the Standard (8-bit) model is made on this computer and needs one more package: $(pkg python3-onnx python3-onnx python-onnx python3-onnx)"
else
  ENGINE=""
  for e in podman docker; do command -v $e >/dev/null && { ENGINE=$e; break; }; done
  echo "System Python ($PY) has no onnxruntime + numpy. Either:"
  echo "  A) install them: $(pkg 'python3-onnxruntime python3-numpy python3-onnx' 'python3-onnxruntime python3-numpy python3-onnx' 'python-onnxruntime python-numpy python-onnx' 'python3-onnxruntime python3-numpy python3-onnx')"
  echo "     and run ./install.sh again, or"
  if [ -z "$ENGINE" ]; then
    echo "  B) install podman and run ./install.sh again."
    exit 1
  fi
  echo "  B) build a local $ENGINE image with them (Fedora packages, ~0.6 GB; the model runs in it without network)."
  ask "Build the image now (B)?" y || { echo "Stopped."; exit 1; }
  $ENGINE build -t dictate-asr -f "$HERE/helper/Containerfile" "$HERE/helper"
  echo "$ENGINE" > "$CONF/runtime"
fi

say "3/5 Installing"
install -D -m 755 "$HERE/helper/dictate" "$BIN"
install -D -m 644 "$HERE/helper/parakeet.py" "$HOME/.local/lib/dictate/parakeet.py"
echo "Helper: $BIN"
if [ "$WITH_EXT" = 1 ]; then
  mkdir -p "$EXT"
  install -m 644 "$HERE"/extension/{metadata.json,extension.js,core.js,keys.js,prefs.js,stylesheet.css,stylesheet-light.css} "$EXT/"
  echo "Extension: $EXT"
fi

say "4/5 Speech model"
if "$BIN" --models | "$PY" -I -c 'import json, sys; sys.exit(0 if json.load(sys.stdin)["used"] else 1)'; then
  echo "Installed."
else
  echo "The Standard model: a 2.5 GB download from Hugging Face (NVIDIA Parakeet TDT 0.6B v3), converted"
  echo "to 8-bit on this computer (about a minute, 6 GB of free memory), then 0.9 GB on disk."
  echo "(Or later: microphone menu -> Settings -> Speech, also for the Full Precision model.)"
  if ask "Download it now?" y; then
    "$BIN" --download int8 || echo "The model is not installed. Try again later: Settings -> Speech -> Speech Model."
  fi
fi

say "5/5 Check"
if "$BIN" --models | "$PY" -I -c 'import json, sys; sys.exit(0 if json.load(sys.stdin)["used"] else 1)'; then
  "$BIN" --selftest
else
  echo "Skipped: no model yet."
fi
if [ "$WITH_EXT" = 1 ] && command -v gsettings >/dev/null; then
  cur=$(gsettings get org.gnome.shell enabled-extensions)
  if [[ $cur != *"'$UUID'"* ]]; then
    new=$("$PY" -I -c 'import ast, sys; l = ast.literal_eval(sys.argv[1].replace("@as ", "")); print(repr(l + [sys.argv[2]]))' "$cur" "$UUID")
    gsettings set org.gnome.shell enabled-extensions "$new"
  fi
fi

cat <<EOT

Done. Log out and log in once, so that GNOME loads the extension. Then:
  Ctrl+Alt+Space   start, speak     Enter   finish: the text is typed where your cursor was
  Caps Lock        pause / resume   Esc     cancel
Settings: the microphone icon in the top bar -> Settings.
EOT
