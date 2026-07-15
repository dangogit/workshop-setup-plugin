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
      *"$BOT_DIR/bot.js"*)
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

stop_previous_copy

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
trap cleanup EXIT INT TERM

if [ "${WA_LAUNCH_SILENT:-0}" = "1" ]; then
  exec >/dev/null 2>&1
  "$NODE" "$BOT_DIR/bot.js" &
else
  "$NODE" "$BOT_DIR/bot.js" &
fi
BOT_PID=$!
printf '%s\n' "$BOT_PID" > "$PID_FILE"
wait "$BOT_PID"
