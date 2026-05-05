---
name: email-agent
description: Install a local Gmail triage agent for Claude Code. The agent reads unread Gmail, classifies messages, creates draft replies only, and sends Telegram or WhatsApp summaries. Use when user says "סוכן מיילים", "email agent", "Gmail agent", "install email agent", "סוכן Gmail".
user-invocable: true
---

# Email Agent — Installation

Install a local Gmail triage agent that runs through Claude Code. It reads unread Gmail messages, classifies them as important or noise, creates Gmail drafts for important messages, and sends a Telegram or WhatsApp summary.

**Safety:** the agent only creates drafts. It does not send, delete, archive, or mark emails as read.

---

## Pre-flight

Tell the user what they are about to get, in Hebrew:

> "אתקין לך סוכן מיילים מקומי שרץ דרך Claude Code. הוא יקרא מיילים שלא נקראו, יסנן רעש, ייצור טיוטות לתשובות חשובות בלבד, וישלח לך סיכום לטלגרם או וואטסאפ."

Then check prerequisites:

```bash
echo "Platform: $(uname -sm)"
command -v claude >/dev/null && echo "claude:OK" || echo "MISSING:claude"
command -v python3 >/dev/null && echo "python3:OK" || echo "MISSING:python3"
command -v curl >/dev/null && echo "curl:OK" || echo "MISSING:curl"
```

Required:
- macOS
- Claude Code CLI
- Python 3
- curl
- Gmail connected to Claude
- Telegram bot token or a local WhatsApp bot

If Claude Code is missing, tell the user to install it:

```bash
npm install --ignore-scripts -g @anthropic-ai/claude-code
```

---

## Step 1 — Install Files

Install location:

```bash
~/claude-email-agent
```

The template files are at `<SKILL_DIR>/template/`, where `<SKILL_DIR>` is the directory containing this `SKILL.md`. Resolve it first.

```bash
INSTALL=~/claude-email-agent
mkdir -p "$INSTALL"
cp -R "<SKILL_DIR>/template/." "$INSTALL/"
chmod +x "$INSTALL"/*.sh
```

---

## Step 2 — Run Setup

Run the setup wizard:

```bash
cd ~/claude-email-agent
./setup.sh
```

The setup wizard asks for:
- user name
- email address for no-reply summaries
- Telegram or WhatsApp notification setup

For Telegram, the user needs a bot token from `@BotFather`.

---

## Step 3 — Connect Gmail

Tell the user:

> "עכשיו צריך לחבר Gmail לקלוד. לך ל־Claude.ai → Settings → Integrations → Gmail → Connect, או בתוך Claude Code תריץ `/mcp` ותוסיף Gmail."

If Claude asks for tool permissions, allow:

```text
mcp__claude_ai_Gmail__search_threads
mcp__claude_ai_Gmail__get_thread
mcp__claude_ai_Gmail__create_draft
```

---

## Step 4 — Train

Run:

```bash
cd ~/claude-email-agent
./train.sh
```

The user classifies recent messages as important/noise. This updates `rules.json`.

---

## Step 5 — Test

Run a manual test:

```bash
cd ~/claude-email-agent
./agent.sh
```

Expected:
- it scans unread Gmail from the last 24 hours
- creates drafts for important messages
- sends a summary notification
- writes local logs under `logs/`

---

## Step 6 — Optional Schedule

Only if the user wants it running automatically:

```bash
cd ~/claude-email-agent
./install-launchd.sh
```

To remove the schedule:

```bash
cd ~/claude-email-agent
./uninstall-launchd.sh
```

---

## Final Message To User

After installation, tell the user in Hebrew:

> "מוכן. הסוכן נמצא ב־`~/claude-email-agent`. קודם חבר Gmail, אחר כך תריץ `./train.sh`, ואז `./agent.sh`. אם תרצה שהוא ירוץ לבד במהלך היום, תריץ `./install-launchd.sh`."

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing .env` | Run `./setup.sh` |
| Gmail tools unavailable | Connect Gmail in Claude integrations or `/mcp` |
| Claude usage limit | Wait for the reset time shown by Claude |
| Telegram notification fails | Recheck `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` |
| No drafts created | Check `logs/` and verify unread messages exist |
| Auto schedule not wanted | Run `./uninstall-launchd.sh` |
