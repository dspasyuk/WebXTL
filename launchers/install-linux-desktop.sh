#!/usr/bin/env bash
#
# Installs the WebXTL desktop launcher on Linux:
#   - copies WebXTL.desktop to ~/Desktop and the application menu
#   - marks it executable and trusted so GNOME/DING will launch it
#
set -euo pipefail

LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$LAUNCHER_DIR/.." && pwd)"
SRC="$LAUNCHER_DIR/WebXTL.desktop"

[ -f "$SRC" ] || { echo "Error: $SRC not found" >&2; exit 1; }

# Prefer the system gio: a conda/venv gio (e.g. xraylarch) cannot write
# GNOME's metadata::trusted attribute and fails with "not supported".
GIO="/usr/bin/gio"
[ -x "$GIO" ] || GIO="$(command -v gio)"

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR" "$APPS_DIR"

# Rewrite the paths in the template to this machine's location.
generate() {
    local target="$1"
    sed -e "s|__APP_DIR__|$APP_DIR|g" "$SRC" > "$target"
    chmod 755 "$target"
}

generate "$DESKTOP_DIR/WebXTL.desktop"
generate "$APPS_DIR/WebXTL.desktop"

# Trust the copy on the desktop so DING lets it launch.
if [ -x "$GIO" ]; then
    "$GIO" set "$DESKTOP_DIR/WebXTL.desktop" metadata::trusted true 2>/dev/null \
        && echo "Marked $(basename "$DESKTOP_DIR/WebXTL.desktop") as trusted." \
        || echo "Warning: could not mark the launcher trusted; right-click it and choose 'Allow Launching'." >&2
    # Touch after setting trust so DING re-reads the file and picks up the flag.
    touch "$DESKTOP_DIR/WebXTL.desktop" 2>/dev/null || true
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" 2>/dev/null || true

echo "Installed:"
echo "  $DESKTOP_DIR/WebXTL.desktop"
echo "  $APPS_DIR/WebXTL.desktop"
