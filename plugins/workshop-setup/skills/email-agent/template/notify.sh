#!/bin/bash
# Send a notification via Telegram or WhatsApp. Usage: ./notify.sh "message text"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"

MESSAGE="$1"
METHOD="${NOTIFY_METHOD:-telegram}"

if [ "$METHOD" = "whatsapp" ]; then
  if [ -z "${WHATSAPP_PHONE:-}" ]; then
    echo "Error: WHATSAPP_PHONE must be set in .env"
    exit 1
  fi

  WHATSAPP_BOT_DIR="${WHATSAPP_BOT_DIR:-$HOME/claude-whatsapp-bot}"

  MESSAGE="$MESSAGE" WHATSAPP_PHONE="$WHATSAPP_PHONE" node -e "
    const { spawn } = require('child_process');
    const phone = process.env.WHATSAPP_PHONE;
    const msg = process.env.MESSAGE;
    const p = spawn('claude', ['-p', 'Send a WhatsApp message to ' + phone + ' with this text: ' + msg], {
      cwd: process.env.WHATSAPP_BOT_DIR || require('os').homedir() + '/claude-whatsapp-bot'
    });
    p.stdout.on('data', d => process.stdout.write(d));
    p.stderr.on('data', d => process.stderr.write(d));
    p.on('close', c => process.exit(c));
  " 2>/dev/null || {
    echo "WhatsApp send failed, falling back to stdout"
    echo "$MESSAGE"
    exit 1
  }

  echo "WhatsApp message sent."

elif [ "$METHOD" = "telegram" ]; then
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env"
    exit 1
  fi

  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="$TELEGRAM_CHAT_ID" \
    --data-urlencode text="$MESSAGE" \
    > /dev/null

  echo "Telegram message sent."

else
  echo "Error: NOTIFY_METHOD must be 'telegram' or 'whatsapp' (got: $METHOD)"
  exit 1
fi
