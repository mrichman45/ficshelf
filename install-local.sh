#!/usr/bin/env bash
# Install (or remove) a locally built FicShelf under /usr/local on Linux.
#
#   sudo ./install-local.sh              install the release build
#   sudo ./install-local.sh --uninstall  remove it again
#
# Only the program, its icons and its menu entry are touched. The library
# (database, covers, downloaded works) lives in ~/.local/share/org.ficshelf.app
# and is never removed by this script.

set -euo pipefail

PREFIX=/usr/local
APP_ID=org.ficshelf.app
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/src-tauri/target/release/ficshelf"
ICONS="$HERE/src-tauri/icons"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

refresh() {
  update-desktop-database -q "$PREFIX/share/applications" 2>/dev/null || true
  gtk-update-icon-cache -q -t "$PREFIX/share/icons/hicolor" 2>/dev/null || true
}

uninstall() {
  # Both names, so an install from an older copy of this script goes too.
  rm -f "$PREFIX/bin/ficshelf" \
        "$PREFIX/share/applications/$APP_ID.desktop" \
        "$PREFIX/share/applications/ficshelf.desktop"
  for size in 32x32 128x128 256x256 512x512; do
    rm -f "$PREFIX/share/icons/hicolor/$size/apps/ficshelf.png" \
          "$PREFIX/share/icons/hicolor/$size/apps/$APP_ID.png"
  done
  refresh
  echo "FicShelf removed. Your library in ~/.local/share/$APP_ID was left alone."
}

if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall
  exit 0
fi

if [[ ! -x "$BIN" ]]; then
  echo "No build found at $BIN" >&2
  echo "Build first:  npm install && npm run tauri build -- --no-bundle" >&2
  exit 1
fi

install -Dm755 "$BIN" "$PREFIX/bin/ficshelf"
install -Dm644 "$ICONS/32x32.png"       "$PREFIX/share/icons/hicolor/32x32/apps/ficshelf.png"
install -Dm644 "$ICONS/128x128.png"     "$PREFIX/share/icons/hicolor/128x128/apps/ficshelf.png"
install -Dm644 "$ICONS/128x128@2x.png"  "$PREFIX/share/icons/hicolor/256x256/apps/ficshelf.png"
install -Dm644 "$ICONS/icon.png"        "$PREFIX/share/icons/hicolor/512x512/apps/ficshelf.png"

# Named after the app id, which is what Wayland compositors (Plasma included)
# use to match the running window to its menu entry and taskbar icon.
install -Dm644 /dev/stdin "$PREFIX/share/applications/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=FicShelf
GenericName=Reading Library
Comment=Read and organise EPUB, PDF and CBZ files
Exec=$PREFIX/bin/ficshelf
Icon=ficshelf
Terminal=false
Categories=Office;Viewer;
Keywords=ebook;epub;pdf;comic;cbz;fanfiction;ao3;
StartupWMClass=ficshelf
EOF

# An older copy of this script used a different file name; drop it so the
# menu does not show FicShelf twice.
rm -f "$PREFIX/share/applications/ficshelf.desktop"

refresh
echo "Installed. FicShelf is in your application menu; or run: ficshelf"
