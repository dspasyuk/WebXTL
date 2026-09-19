#!/usr/bin/env bash
#
# Stops a WebXTL server started by WebXTL.sh on the configured port.
#
set -euo pipefail

PORT="${PORT:-3000}"
pids=""

if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "${PORT}/tcp" 2>/dev/null || true)"
elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -lptn "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)"
fi

if [ -z "${pids// /}" ]; then
    echo "No WebXTL server found on port ${PORT}."
    exit 0
fi

kill $pids 2>/dev/null || true
echo "Stopped WebXTL server (PID: $pids)."
