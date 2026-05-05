#!/bin/bash
# Remove the macOS LaunchAgent schedule.
set -euo pipefail

LABEL="com.email-agent"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "Removed $LABEL"
