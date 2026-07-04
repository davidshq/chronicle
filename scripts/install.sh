#!/usr/bin/env bash
# Chronicle installer: builds the binary, installs it into the plugin's bin/,
# optionally migrates the old ~/.claude-logs store, and registers the capture
# daemon as a user service (systemd on Linux, launchd on macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building chronicle (release)…"
cargo build --release

mkdir -p "$ROOT/bin"
cp "$ROOT/target/release/chronicle" "$ROOT/bin/chronicle"
echo "==> Installed binary at $ROOT/bin/chronicle"

# Also expose on PATH for the daemon service if ~/.local/bin exists.
if [ -d "$HOME/.local/bin" ]; then
  cp "$ROOT/target/release/chronicle" "$HOME/.local/bin/chronicle"
  echo "==> Also installed at ~/.local/bin/chronicle"
fi
BIN="$ROOT/bin/chronicle"

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
