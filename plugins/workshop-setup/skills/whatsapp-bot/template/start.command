#!/bin/bash
# WhatsApp ↔ Claude Bot - double-click to start
cd "$(dirname "$0")"

# kill any previous instance
pkill -f "node.*bot.js" 2>/dev/null
lsof -ti:7654 2>/dev/null | xargs -r kill -9 2>/dev/null
sleep 1

# find node
NODE=""
for p in "$HOME/.local/node/bin/node" /usr/local/bin/node /opt/homebrew/bin/node "$(command -v node)"; do
  if [ -x "$p" ]; then NODE="$p"; break; fi
done
if [ -z "$NODE" ]; then
  echo "❌ Node.js לא מותקן. התקן מ: https://nodejs.org"
  read -p "Press any key to close..." -n 1
  exit 1
fi

# ensure claude is in PATH
if ! command -v claude >/dev/null 2>&1; then
  for p in "$HOME/.local/node/bin" /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$p/claude" ]; then export PATH="$p:$PATH"; break; fi
  done
fi

# first-run: install deps
if [ ! -d node_modules ]; then
  echo "📦 מתקין dependencies (פעם אחת, ~30 שניות)..."
  "$NODE" "$(dirname "$NODE")/npm" install --no-fund --no-audit --loglevel=error || npm install --no-fund --no-audit --loglevel=error
fi

cat <<EOF

╔════════════════════════════════════╗
║   🤖  WhatsApp ↔ Claude  Agent    ║
╚════════════════════════════════════╝

  Node:   $NODE
  Claude: $(command -v claude || echo '⚠️ NOT FOUND - run: npm i -g @anthropic-ai/claude-code')
  UI:     http://localhost:7654

  לעצירה: Ctrl+C או סגור חלון

EOF

exec "$NODE" bot.js