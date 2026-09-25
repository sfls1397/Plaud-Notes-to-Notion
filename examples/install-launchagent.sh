#!/bin/sh
# Installs/refreshes the LaunchAgent for the current user (GUI session, so Keychain works).
# Usage: sh install-launchagent.sh [/path/to/bin/plaud-notes-to-notion.js]
# Secrets stay in Keychain (service plaud-notes-to-notion); nothing secret goes in the plist.
set -eu
LABEL=com.plaud-notes-to-notion
NODE=$(command -v node)
BIN=${1:-$(npm root -g)/plaud-notes-to-notion/bin/plaud-notes-to-notion.js}
DIR=$(cd "$(dirname "$0")" && pwd)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
test -f "$BIN" || { echo "Not found: $BIN" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#REPLACE_NODE#$NODE#" -e "s#REPLACE_BIN#$BIN#" -e "s#REPLACE_HOME#$HOME#g" "$DIR/$LABEL.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Loaded $LABEL → $NODE $BIN run"
