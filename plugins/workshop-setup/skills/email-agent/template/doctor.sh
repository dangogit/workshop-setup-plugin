#!/bin/bash
# Diagnose local email-agent setup without reading Gmail or sending notifications.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FAILURES=0
WARNINGS=0

ok() {
  printf 'OK    %s\n' "$1"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  printf 'WARN  %s\n' "$1"
}

fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL  %s\n' "$1"
}

check_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1 found"
  else
    fail "$1 missing"
  fi
}

echo "Email Agent Doctor"
echo "=================="
echo ""

check_cmd claude
check_cmd python3
check_cmd curl

echo ""
echo "Local files"
echo "-----------"

if [ -f "$SCRIPT_DIR/.env" ]; then
  ok ".env exists"
  # shellcheck disable=SC1091
  if source "$SCRIPT_DIR/.env" 2>/dev/null; then
    ok ".env loads"
  else
    fail ".env has shell syntax errors"
  fi
else
  fail ".env missing. Run ./setup.sh"
fi

for f in rules.json state.json stats.json; do
  if [ -f "$SCRIPT_DIR/$f" ]; then
    if python3 -m json.tool "$SCRIPT_DIR/$f" >/dev/null 2>&1; then
      ok "$f valid JSON"
    else
      fail "$f invalid JSON"
    fi
  else
    warn "$f missing. It will be created by setup.sh or agent.sh"
  fi
done

mkdir -p "$SCRIPT_DIR/logs"
ok "logs directory ready"

echo ""
echo "Claude"
echo "------"

if command -v claude >/dev/null 2>&1; then
  if claude auth status >/tmp/email-agent-auth-status.$$ 2>&1; then
    ok "Claude auth active"
  else
    fail "Claude auth not active. Run: claude auth login"
    sed 's/^/      /' /tmp/email-agent-auth-status.$$
  fi
  rm -f /tmp/email-agent-auth-status.$$

  if claude mcp list >/tmp/email-agent-mcp-list.$$ 2>&1; then
    if grep -Eiq 'gmail.*connected|connected.*gmail' /tmp/email-agent-mcp-list.$$; then
      ok "Gmail MCP appears connected"
    elif grep -Eiq 'gmail' /tmp/email-agent-mcp-list.$$; then
      warn "Gmail MCP found but may need authentication"
    else
      warn "Gmail MCP not found. Connect Gmail through Claude integrations or /mcp"
    fi
  else
    warn "Could not inspect MCP list"
    sed 's/^/      /' /tmp/email-agent-mcp-list.$$
  fi
  rm -f /tmp/email-agent-mcp-list.$$
fi

echo ""
echo "Notifications"
echo "-------------"

METHOD="${NOTIFY_METHOD:-}"
case "$METHOD" in
  telegram)
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
      ok "Telegram config present"
      if curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" >/dev/null 2>&1; then
        ok "Telegram bot token works"
      else
        warn "Telegram token check failed"
      fi
    else
      fail "Telegram selected but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing"
    fi
    ;;
  whatsapp)
    if [ -n "${WHATSAPP_PHONE:-}" ]; then
      ok "WhatsApp phone configured"
    else
      fail "WhatsApp selected but WHATSAPP_PHONE is missing"
    fi

    if [ -d "${WHATSAPP_BOT_DIR:-$HOME/claude-whatsapp-bot}" ]; then
      ok "WhatsApp bot directory found"
    else
      warn "WhatsApp bot directory not found"
    fi
    ;;
  '')
    fail "NOTIFY_METHOD missing in .env"
    ;;
  *)
    fail "Unknown NOTIFY_METHOD: $METHOD"
    ;;
esac

echo ""
echo "Config"
echo "------"

if [ -n "${FORWARD_TO_EMAIL:-}" ]; then
  ok "FORWARD_TO_EMAIL set"
else
  fail "FORWARD_TO_EMAIL missing"
fi

if [ -n "${CLAUDE_MODEL:-haiku}" ]; then
  ok "CLAUDE_MODEL=${CLAUDE_MODEL:-haiku}"
fi

case "${MAX_THREADS:-20}" in
  ''|*[!0-9]*)
    fail "MAX_THREADS must be a positive integer"
    ;;
  *)
    ok "MAX_THREADS=${MAX_THREADS:-20}"
    ;;
esac

if [ -n "${LOOKBACK_QUERY:-is:unread newer_than:1d}" ]; then
  ok "LOOKBACK_QUERY=${LOOKBACK_QUERY:-is:unread newer_than:1d}"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "Result: ready with $WARNINGS warning(s)."
  exit 0
fi

echo "Result: $FAILURES failure(s), $WARNINGS warning(s). Fix failures before running ./agent.sh"
exit 1
