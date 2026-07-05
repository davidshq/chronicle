#!/usr/bin/env bash
# Chronicle installer: builds the binary, installs it into the plugin's bin/,
# optionally migrates the old ~/.claude-logs store, and registers the capture
# daemon as a user service (systemd on Linux, launchd on macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --store <dir>: where the store (config + data layers) lives. Defaults to the
# anchor (~/.chronicle). This is an install-time argument, not runtime config —
# it's written into the anchor's store-path pointer, which is the source of truth.
usage() { echo "Usage: $0 [--store <dir>]"; }
STORE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --store) STORE_ARG="${2:?--store requires a directory}"; shift 2 ;;
    --store=*) STORE_ARG="${1#--store=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

echo "==> Building chronicle (release)…"
cargo build --release

# The anchor is a fixed, well-known location (~/.chronicle) that both the daemon
# service and the in-session plugin reference by absolute path. It holds the one
# installed binary — a single source of truth, so the plugin can never drift to a
# different version than the daemon — and the store-path pointer. (cf. ~/.cargo.)
ANCHOR="$HOME/.chronicle"
BIN_DIR="$ANCHOR/bin"
BIN="$BIN_DIR/chronicle"
mkdir -p "$BIN_DIR"
cp "$ROOT/target/release/chronicle" "$BIN"
echo "==> Installed binary at $BIN"

# Where the store (config + data layers) actually lives. Defaults to the anchor;
# pass --store to keep the bulky raw/markdown/index elsewhere (bigger disk,
# encrypted volume, …). A one-line pointer in the anchor redirects every
# invocation there — no environment needed at runtime.
STORE="${STORE_ARG:-$ANCHOR}"
mkdir -p "$STORE"
# Canonicalize to an absolute path: the daemon runs under systemd/launchd with an
# unpredictable CWD, so a relative pointer would resolve to the wrong place. This
# also normalizes a trailing slash, so "~/.chronicle/" still matches the anchor.
STORE="$(cd "$STORE" && pwd)"
if [ "$STORE" = "$ANCHOR" ]; then
  rm -f "$ANCHOR/store-path"        # store is the anchor: no redirection
else
  printf '%s\n' "$STORE" > "$ANCHOR/store-path"
  echo "==> Store located at $STORE (via $ANCHOR/store-path)"
fi

# Also expose on PATH for interactive use if ~/.local/bin exists.
if [ -d "$HOME/.local/bin" ]; then
  cp "$ROOT/target/release/chronicle" "$HOME/.local/bin/chronicle"
  echo "==> Also installed at ~/.local/bin/chronicle (for interactive PATH use)"
fi

# Migrate after the pointer is written, so it imports into the resolved store.
echo "==> Migrating any existing ~/.claude-logs store…"
"$BIN" migrate || true

OS="$(uname -s)"
case "$OS" in
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/chronicle.service" <<EOF
[Unit]
Description=Chronicle capture daemon (lossless Claude Code session recorder)

[Service]
# No --store needed: the daemon resolves the store from the anchor's store-path
# pointer at runtime, so it works regardless of the (scrubbed) service env.
ExecStart=$BIN daemon
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload
      systemctl --user enable --now chronicle.service
      echo "==> chronicle.service enabled and started (systemd --user)."
      echo "    Logs: journalctl --user -u chronicle -f"
    else
      echo "!! systemctl not available; start manually: $BIN daemon &"
    fi
    ;;
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.davidshq.chronicle.plist"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.davidshq.chronicle</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "==> Chronicle launch agent loaded."
    ;;
  *)
    echo "!! Unknown OS '$OS'; start the daemon manually: $BIN daemon &"
    ;;
esac

echo
echo "Done. Check capture health any time with:  $BIN status"
