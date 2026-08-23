#!/bin/bash
# WhatsApp Claude Bot - double-click to start
set -u
cd "$(dirname "$0")" || exit 1

BOT_DIR="$PWD"
PID_FILE="$BOT_DIR/.bot.pid"
PORT="${PORT:-7654}"

stop_previous_copy() {
  [ -f "$PID_FILE" ] || return 0
  old_pid="$(tr -dc '0-9' < "$PID_FILE")"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    old_command="$(ps -p "$old_pid" -o command= 2>/dev/null || true)"
    case "$old_command" in
      *"$BOT_DIR/hub.js"*)
        echo "עוצר עותק קודם של הסוכן..."
        kill "$old_pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
          kill -0 "$old_pid" 2>/dev/null || break
          sleep 1
        done
        ;;
      *) echo "מתעלם מקובץ PID ישן שלא שייך לסוכן הזה." ;;
    esac
  fi
  rm -f "$PID_FILE"
}

# Closing the Terminal window sends SIGHUP. If a previous hub.js died from
# that (see the HUP trap below) without running its own shutdown, every
# per-account bot.js child it spawned is orphaned - no PID file tracks them,
# and each one still holds its port and its live WhatsApp socket. Find them by
# command line and stop them before a fresh hub starts, otherwise the new hub
# either collides with their ports or spawns duplicate accounts alongside them.
find_stale_account_pids() {
  pgrep -f 'bot\.js' 2>/dev/null | while read -r p; do
    [ -n "$p" ] || continue
    cmd="$(ps -p "$p" -o command= 2>/dev/null || true)"
    case "$cmd" in
      *"$BOT_DIR/bot.js"*) printf '%s\n' "$p" ;;
    esac
  done
}

stop_orphaned_accounts() {
  local stale
  stale="$(find_stale_account_pids)"
  [ -n "$stale" ] || return 0
  echo "⚠️ נמצאו תהליכי חשבון ישנים שנשארו פעילים מהרצה קודמת (יתכן שהחלון נסגר בלי לעצור אותם כראוי):"
  printf '%s\n' "$stale" | while read -r p; do echo "   PID $p"; done
  echo "עוצר אותם כדי לפנות את הפורטים שלהם ולמנוע חשבונות כפולים..."
  printf '%s\n' "$stale" | while read -r p; do kill "$p" 2>/dev/null || true; done
  for _ in 1 2 3 4 5; do
    [ -n "$(find_stale_account_pids)" ] || break
    sleep 1
  done
  if [ -n "$(find_stale_account_pids)" ]; then
    echo "⚠️ חלק מתהליכי החשבון הישנים לא נעצרו - ייתכן שהחשבונות המתאימים יתנגשו בפורטים שלהם."
  fi
}

stop_previous_copy
stop_orphaned_accounts

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ פורט $PORT כבר בשימוש על ידי תוכנה אחרת. לא עצרתי אותה."
  echo "סגור את התוכנה שמשתמשת בפורט או הפעל עם PORT אחר."
  read -r -p "לחץ Enter לסגירה..."
  exit 1
fi

NODE=""
for candidate in "$HOME/.local/node/bin/node" /usr/local/bin/node /opt/homebrew/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  echo "❌ Node.js לא מותקן. התקן מ: https://nodejs.org"
  read -r -p "לחץ Enter לסגירה..."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  for candidate in "$HOME/.local/node/bin" /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$candidate/claude" ]; then export PATH="$candidate:$PATH"; break; fi
  done
fi

if [ ! -d node_modules ]; then
  echo "📦 מתקין רכיבים בפעם הראשונה..."
  NPM="$(dirname "$NODE")/npm"
  if [ -x "$NPM" ]; then
    "$NPM" install --ignore-scripts --no-fund --no-audit --loglevel=error || exit 1
  else
    npm install --ignore-scripts --no-fund --no-audit --loglevel=error || exit 1
  fi
fi

cat <<EOF

╔════════════════════════════════════╗
║   🤖  WhatsApp ↔ Claude Agent     ║
╚════════════════════════════════════╝

  Node:   $NODE
  Claude: $(command -v claude || echo 'לא נמצא - התקן Claude Code')
  ממשק:   http://127.0.0.1:$PORT

  לעצירה: Ctrl+C או סגור את החלון

EOF

cleanup() {
  if [ -n "${BOT_PID:-}" ] && kill -0 "$BOT_PID" 2>/dev/null; then kill "$BOT_PID" 2>/dev/null || true; fi
  rm -f "$PID_FILE"
}
# HUP: closing the Terminal window. Without this, bash dies immediately on
# the default HUP disposition and never runs cleanup, so hub.js is never sent
# SIGTERM and never gets to gracefully stop its per-account children.
trap cleanup EXIT INT TERM HUP

if [ "${WA_LAUNCH_SILENT:-0}" = "1" ]; then
  exec >/dev/null 2>&1
fi
"$NODE" "$BOT_DIR/hub.js" &
BOT_PID=$!
printf '%s\n' "$BOT_PID" > "$PID_FILE"
wait "$BOT_PID"
