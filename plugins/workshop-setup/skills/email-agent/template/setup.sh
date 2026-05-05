#!/bin/bash
# setup.sh - Student-friendly setup script for the Email Agent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
RED="\033[0;31m"
BOLD="\033[1m"
RESET="\033[0m"

step()  { echo -e "\n${CYAN}${BOLD}[Step $1]${RESET} $2"; }
ok()    { echo -e "  ${GREEN}OK${RESET}  $1"; }
warn()  { echo -e "  ${YELLOW}WARN${RESET} $1"; }
fail()  { echo -e "  ${RED}FAIL${RESET} $1"; exit 1; }
ask()   { echo -e "\n${BOLD}$1${RESET}"; }
shell_quote() { printf "%q" "$1"; }

echo ""
echo -e "${BOLD}================================================${RESET}"
echo -e "${BOLD}  Email Agent - Setup${RESET}"
echo -e "${BOLD}================================================${RESET}"
echo ""
echo "This script sets up your email agent in about 5 minutes."
echo ""

# --- Step 1: Prerequisites ---
step 1 "Checking prerequisites..."

command -v claude &>/dev/null && ok "claude CLI found" || fail "claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
command -v python3 &>/dev/null && ok "python3 found" || fail "python3 not found. Install from https://python.org"
command -v curl &>/dev/null && ok "curl found" || fail "curl not found"

# --- Step 2: User profile ---
step 2 "Setting up your profile"

ask "What name should the agent use for you?"
read -r USER_NAME
[ -z "$USER_NAME" ] && USER_NAME="Email Agent User"

ask "Where should no-reply summaries be drafted to? Enter your email:"
read -r FORWARD_TO_EMAIL
[ -z "$FORWARD_TO_EMAIL" ] && fail "No email entered."

# --- Step 3: Choose notification method ---
step 3 "Choose your notification method"

echo ""
echo "  How do you want to receive email notifications?"
echo ""
echo "  1) Telegram  - create a bot via @BotFather (recommended)"
echo "  2) WhatsApp   - connect via QR code (requires WhatsApp bot setup)"
echo ""

while true; do
  ask "Enter 1 or 2:"
  read -r NOTIFY_CHOICE
  if [ "$NOTIFY_CHOICE" = "1" ] || [ "$NOTIFY_CHOICE" = "2" ]; then
    break
  fi
  echo "  Please enter 1 or 2."
done

# --- Telegram setup ---
if [ "$NOTIFY_CHOICE" = "1" ]; then
  step 4 "Setting up Telegram"

  echo ""
  echo "  To get a Bot Token:"
  echo "  1. Open Telegram and search for @BotFather"
  echo "  2. Send /newbot"
  echo "  3. Choose a name and username (must end in 'bot')"
  echo "  4. Copy the token BotFather gives you"
  echo ""

  ask "Paste your Telegram Bot Token:"
  read -r BOT_TOKEN

  [ -z "$BOT_TOKEN" ] && fail "No token entered."

  printf 'NOTIFY_METHOD=telegram\nTELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=\nUSER_NAME=%s\nFORWARD_TO_EMAIL=%s\nCLAUDE_MODEL=haiku\nLOOKBACK_QUERY=%s\nMAX_THREADS=20\n' \
    "$(shell_quote "$BOT_TOKEN")" \
    "$(shell_quote "$USER_NAME")" \
    "$(shell_quote "$FORWARD_TO_EMAIL")" \
    "$(shell_quote "is:unread newer_than:1d")" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "Token saved (.env secured with 600 permissions)"

  step 5 "Getting your Chat ID"
  echo ""
  echo "  1. Open Telegram"
  echo "  2. Find your bot and send it any message (e.g. 'hello')"
  echo ""

  ask "Press Enter after you sent a message..."
  read -r _

  CHAT_ID=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('result', [])
print(results[-1]['message']['chat']['id'] if results else '')
" 2>/dev/null || echo "")

  if [ -z "$CHAT_ID" ]; then
    warn "Could not detect chat ID automatically."
    ask "Paste your Chat ID manually (or Enter to skip):"
    read -r CHAT_ID
  fi

  if [ -n "$CHAT_ID" ]; then
    if ! [[ "$CHAT_ID" =~ ^-?[0-9]+$ ]]; then
      fail "Invalid chat ID: must be numeric."
    fi
    sed -i '' "s/TELEGRAM_CHAT_ID=.*/TELEGRAM_CHAT_ID=$CHAT_ID/" "$ENV_FILE"
    ok "Chat ID saved: $CHAT_ID"

    step 6 "Testing Telegram..."
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" \
      -d "text=Email Agent setup complete! You will receive notifications here." \
      > /dev/null && ok "Test message sent! Check Telegram." || warn "Test failed. Check token and chat ID."
  else
    warn "No chat ID. Edit .env manually before running the agent."
  fi

# --- WhatsApp setup ---
else
  step 4 "Setting up WhatsApp"

  echo ""
  echo "  WhatsApp notifications use the WhatsApp bot."
  echo "  If you haven't set it up yet, run this in Claude Code:"
  echo ""
  echo "    /whatsapp-bot"
  echo ""
  echo "  This will install the bot and connect via QR code."
  echo ""

  ask "Enter your WhatsApp phone number (with country code, e.g. 972501234567):"
  read -r WA_PHONE

  [ -z "$WA_PHONE" ] && fail "No phone number entered."

  WA_BOT_DIR="$HOME/claude-whatsapp-bot"
  ask "WhatsApp bot directory (Enter for default: $WA_BOT_DIR):"
  read -r WA_DIR_INPUT
  [ -n "$WA_DIR_INPUT" ] && WA_BOT_DIR="$WA_DIR_INPUT"

  printf 'NOTIFY_METHOD=whatsapp\nWHATSAPP_PHONE=%s\nWHATSAPP_BOT_DIR=%s\nUSER_NAME=%s\nFORWARD_TO_EMAIL=%s\nCLAUDE_MODEL=haiku\nLOOKBACK_QUERY=%s\nMAX_THREADS=20\n' \
    "$(shell_quote "$WA_PHONE")" \
    "$(shell_quote "$WA_BOT_DIR")" \
    "$(shell_quote "$USER_NAME")" \
    "$(shell_quote "$FORWARD_TO_EMAIL")" \
    "$(shell_quote "is:unread newer_than:1d")" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "WhatsApp config saved (.env secured with 600 permissions)"

  if [ -d "$WA_BOT_DIR" ]; then
    ok "WhatsApp bot found at $WA_BOT_DIR"
  else
    warn "Bot directory not found at $WA_BOT_DIR"
    echo "  Run /whatsapp-bot in Claude Code to install it."
  fi
fi

# --- Runtime files ---
if [ ! -f "$SCRIPT_DIR/state.json" ]; then
  printf '{\n  "last_run": null,\n  "last_processed_thread_id": null,\n  "processed_thread_ids": [],\n  "total_processed": 0\n}\n' > "$SCRIPT_DIR/state.json"
  ok "Created state.json"
fi

if [ ! -f "$SCRIPT_DIR/stats.json" ]; then
  printf '{\n  "runs": [],\n  "top_senders": {\n    "important": {},\n    "noise": {}\n  },\n  "totals": {\n    "total_processed": 0,\n    "total_important": 0,\n    "total_noise": 0,\n    "total_drafts": 0\n  }\n}\n' > "$SCRIPT_DIR/stats.json"
  ok "Created stats.json"
fi

# --- Gmail connection ---
NEXT_STEP=$((NOTIFY_CHOICE == 1 ? 7 : 5))
step $NEXT_STEP "Connecting Gmail"

echo ""
echo "  The agent reads your Gmail through Claude's built-in Gmail connector."
echo ""
echo "  Two ways to connect:"
echo ""
echo "  Option A - Via Claude.ai (easiest):"
echo "    1. Go to claude.ai/settings"
echo "    2. Click 'Integrations'"
echo "    3. Find Gmail and click Connect"
echo "    4. Authorize your Google account"
echo ""
echo "  Option B - Via Claude Code:"
echo "    1. Open Claude Code"
echo "    2. Type /mcp"
echo "    3. Select 'Add Integration' and find Gmail"
echo ""
echo "  The connection syncs across all Claude products automatically."
echo ""

# --- Done ---
echo ""
echo -e "${GREEN}${BOLD}================================================${RESET}"
echo -e "${GREEN}${BOLD}  Setup complete!${RESET}"
echo -e "${GREEN}${BOLD}================================================${RESET}"
echo ""
echo "  Next steps:"
echo "    1. Connect Gmail (see instructions above)"
echo "    2. Check setup:     ./doctor.sh"
echo "    3. Train the agent: ./train.sh"
echo "    4. Safe test:       ./agent.sh --dry-run"
echo "    5. Live run:        ./agent.sh"
echo "    6. Optional schedule: ./install-launchd.sh"
echo ""
