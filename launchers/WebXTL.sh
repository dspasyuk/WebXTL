#!/usr/bin/env bash
#
# WebXTL launcher for Linux and macOS.
# Starts the local server (if not already running) and opens the browser.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# A GUI launch (desktop/Nautilus/DING) gets a minimal PATH, so the
# crystallography programs added in ~/.bashrc are not visible. Inherit the
# user's interactive shell PATH (set WEBXTL_NO_PROFILE=1 to skip).
if [ -z "${WEBXTL_NO_PROFILE:-}" ]; then
    SHELL_PATH="$(bash -ic 'printf %s "$PATH"' 2>/dev/null || true)"
    if [ -n "$SHELL_PATH" ]; then
        export PATH="$SHELL_PATH:$PATH"
    fi
fi

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
LOG_FILE="$APP_DIR/.webxtl.log"

find_node() {
    if command -v node >/dev/null 2>&1; then
        command -v node
        return 0
    fi
    local candidate
    for candidate in \
        "$HOME/node/bin/node" \
        "$HOME"/.nvm/versions/node/*/bin/node \
        /usr/local/bin/node \
        /opt/homebrew/bin/node \
        /usr/bin/node; do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

open_browser() {
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$URL" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
        open "$URL" >/dev/null 2>&1 &
    elif command -v sensible-browser >/dev/null 2>&1; then
        sensible-browser "$URL" >/dev/null 2>&1 &
    fi
}

server_is_up() {
    if command -v curl >/dev/null 2>&1; then
        curl -s -o /dev/null --max-time 1 "$URL"
    else
        "$NODE" -e "
            require('http').get('$URL', r => process.exit(0))
              .on('error', () => process.exit(1))
        " >/dev/null 2>&1
    fi
}

if ! NODE="$(find_node)"; then
    echo "Error: Node.js was not found. Please install Node.js from https://nodejs.org" >&2
    exit 1
fi

if [ ! -f "$APP_DIR/server.js" ]; then
    echo "Error: server.js not found in $APP_DIR" >&2
    exit 1
fi

if server_is_up; then
    echo "WebXTL is already running at $URL"
    open_browser
    exit 0
fi

echo "Starting WebXTL server on $URL ..."
nohup "$NODE" "$APP_DIR/server.js" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 80); do
    if server_is_up; then
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "Error: the WebXTL server exited unexpectedly. See $LOG_FILE" >&2
        exit 1
    fi
    sleep 0.25
done

if ! server_is_up; then
    echo "Warning: server did not become ready in time. See $LOG_FILE" >&2
fi

open_browser
echo "WebXTL started (PID $SERVER_PID). Logs: $LOG_FILE"
