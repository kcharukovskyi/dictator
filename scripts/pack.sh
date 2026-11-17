#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2025-2026 The Dictator authors (see AUTHORS)
# Builds dist/<uuid>.shell-extension.zip, the file to upload to extensions.gnome.org.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
gnome-extensions pack extension --force --out-dir=dist \
  --extra-source=core.js --extra-source=keys.js --extra-source=stylesheet-light.css
ls -l dist/*.zip
