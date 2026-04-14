---
name: whatsapp-bot
description: Install a personal WhatsApp ↔ Claude bot that runs locally on Mac/Windows/Linux. The user messages the bot from their phone and Claude responds with full access to their files. Use when user says "חבר ווטסאפ לקלוד", "סוכן ווטסאפ", "WhatsApp bot", "connect WhatsApp", "סוכן AI בווטסאפ", "התקן את הבוט".
user-invocable: true
---

# WhatsApp ↔ Claude Bot — Installation

Install a local Node.js bot that bridges WhatsApp ↔ Claude Code. Users message their bot from WhatsApp and Claude responds (voice, text, images, full file access).

**Goal:** get the user from zero to working bot in under 5 minutes, with minimal questions.

---

## Pre-flight

Before anything, **tell the user what they're about to get**, in 2 sentences:
> "אתקין סוכן WhatsApp אישי שירוץ על המחשב שלך. אחרי ההתקנה — תסרוק QR, תוסיף את המספר שלך דרך כפתור פשוט, ותבחר בין 'עוזר אישי' (יכול לבנות לך דברים) או 'צ'אט בוט' (קוראים בלבד, לקבוצות)."

---

## Step 1 — Platform + prerequisites

Detect platform. Run the right command.

**macOS/Linux** (Bash):
```bash
echo "Platform: $(uname -sm)"
node --version 2>/dev/null || echo "MISSING:node"
command -v claude >/dev/null && echo "claude:OK" || echo "MISSING:claude"
```

**Windows** (PowerShell):
```powershell
$env:OS; node --version 2>$null; (Get-Command claude -ErrorAction SilentlyContinue) ?? "MISSING:claude"
```

Required:
- **Node.js 18+** — if missing, direct to https://nodejs.org (LTS). On Mac with Homebrew: offer `brew install node`. Don't proceed until installed.
- **Claude Code CLI** — if missing, run `npm install -g @anthropic-ai/claude-code`. Auto-install is OK here.

---

## Step 2 — One question

Ask ONLY this (one at a time, in Hebrew):

> **"איזו תיקייה הסוכן יעבוד בה? (איפה הוא יראה קבצים)**
>
> ברירת מחדל: תיקיית הבית שלך. אפשר גם תיקיית פרויקט ספציפית."

Store as `$WORKDIR`. If user says "ברירת מחדל" or blank → use `~` (macOS/Linux) / `$env:USERPROFILE` (Windows).

**Don't ask for phone number!** User will add via the pairing wizard after install — much easier than figuring out international format.

---

## Step 3 — Install

Install location:
- macOS/Linux: `~/claude-whatsapp-bot/`
- Windows: `%USERPROFILE%\claude-whatsapp-bot\`

The template files are at `<SKILL_DIR>/template/` where `<SKILL_DIR>` is the directory containing this SKILL.md. Resolve it first.

**macOS/Linux:**
```bash
INSTALL=~/claude-whatsapp-bot
mkdir -p "$INSTALL/auth"
cp -R "<SKILL_DIR>/template/." "$INSTALL/"
chmod +x "$INSTALL/start.command"
```

**Windows (PowerShell):**
```powershell
$INSTALL = "$env:USERPROFILE\claude-whatsapp-bot"
New-Item -ItemType Directory -Force -Path "$INSTALL\auth" | Out-Null
Copy-Item -Recurse -Force "<SKILL_DIR>\template\*" -Destination $INSTALL
```

---

## Step 4 — Write config.json

Write `$INSTALL/config.json` with **empty whitelist** — user will pair via UI:

```json
{
  "agentName": "הסוכן שלי",
  "workdir": "<WORKDIR>",
  "model": "sonnet",
  "whitelist": [],
  "publicMode": false,
  "groupMode": "off",
  "permissionMode": "bypassPermissions",
  "systemPromptAppend": "",
  "openaiApiKey": "",
  "ttsMode": "mirror",
  "ttsVoice": "alloy"
}
```

Default mode = **assistant** (bypass + groups off). User can switch via UI.

---

## Step 5 — Install deps

```bash
cd "$INSTALL" && npm install --no-fund --no-audit
```

Takes ~30 seconds. First-time only.

---

## Step 6 — Launch

Run bot in background so the user can see QR in browser.

**macOS/Linux:**
```bash
cd "$INSTALL" && nohup node bot.js > /tmp/wa-bot.log 2>&1 &
disown
```

**Windows:**
```powershell
Start-Process -WindowStyle Hidden node -ArgumentList "bot.js" -WorkingDirectory $INSTALL -RedirectStandardOutput "$env:TEMP\wa-bot.log"
```

Wait 3 seconds, then verify:
```bash
curl -s http://localhost:7654/state | head -c 200
```

Should return JSON with `"status":"qr"`. Browser opens automatically.

---

## Step 7 — Desktop shortcut (optional but nice)

**macOS:**
```bash
ln -sf "$INSTALL/start.command" ~/Desktop/"🤖 WhatsApp Agent.command"
```

**Windows (PowerShell):**
```powershell
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$env:USERPROFILE\Desktop\WhatsApp Agent.lnk")
$s.TargetPath = "$INSTALL\start.bat"
$s.Save()
```

---

## Step 8 — User walkthrough

Tell the user, in Hebrew, in this exact sequence:

> **"מוכן! הדפדפן נפתח ב-http://localhost:7654. 3 פעולות:**
>
> **1. סרוק QR** — בטלפון: WhatsApp → הגדרות → מכשירים מקושרים → קישור מכשיר → סרוק.
>
> **2. חבר את המספר שלך** — אחרי שהסטטוס ירוק ('מחובר'), לחץ **'📱 חבר טלפון'**. יופיע קוד 6 ספרות. שלח את הקוד ב-WhatsApp מהמכשיר שתרצה לדבר עם הסוכן — הוא יתווסף אוטומטית ל-whitelist.
>
> **3. בחר מצב** — עבור לטאב 'הגדרות' ובחר:
> - **🧑‍💻 עוזר אישי** — אתה לבד, הסוכן עושה הכל (עריכה, bash, בנייה)
> - **💬 צ'אט בוט** — לקבוצות/לקוחות, קריאה בלבד, מגיב רק עם @
>
> **שלח הודעה לעצמך עם 'היי' → תראה תשובה בווטסאפ תוך 3 שניות."**

---

## Step 9 — Verify

After user says they paired + picked mode, run:
```bash
curl -s http://localhost:7654/state | python3 -c "import json,sys;s=json.load(sys.stdin);print('status:',s['status'],'| stats:',s['stats'],'| whitelist:',s['config']['whitelist'])"
```

Expected: status=connected, whitelist has user's number, messagesIn ≥ 1 after they test.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 7654 already in use | `lsof -ti:7654 \| xargs kill` (Mac) / `netstat -ano \| findstr :7654` → `taskkill /PID X /F` (Win) |
| `claude: command not found` after install | Run `npm install -g @anthropic-ai/claude-code` + restart terminal |
| QR doesn't appear in browser | Check `/tmp/wa-bot.log` or `%TEMP%\wa-bot.log` for errors |
| Windows SmartScreen blocks `.bat` | Right-click → Properties → Unblock, or "More info" → "Run anyway" |
| "bad-request 515" on connect | Click 🔄 "סריקה מחדש" in UI |
| Blocked messages from user's own number | Pairing handles this; ask user to use the 📱 pair button |
| Hebrew comes out garbled in cmd.exe | `start.bat` already sets `chcp 65001`; make sure they double-click it rather than running in plain cmd |

---

## Configuration reference

All settings editable from the browser UI. Config stored at `$INSTALL/config.json`:

| Field | Meaning |
|---|---|
| `agentName` | Display name |
| `workdir` | Directory Claude has access to (can be overridden per-chat with `/cd path`) |
| `model` | `sonnet` (default) / `opus` / `haiku` |
| `whitelist` | Array of phone user-parts (e.g. `"972501234567"`) |
| `publicMode` | `true` = anyone can message (⚠️) |
| `groupMode` | `off` / `mention` / `always` |
| `permissionMode` | `plan` / `acceptEdits` / `bypassPermissions` |
| `systemPromptAppend` | Extra instructions for Claude |
| `openaiApiKey` | Optional, for voice transcription + TTS |
| `ttsMode` | `off` / `mirror` (reply in kind) / `always` |
| `ttsVoice` | `alloy`/`nova`/`shimmer`/`onyx`/`echo`/`fable` |

---

## What to tell users about modes

**🧑‍💻 עוזר אישי (assistant)** — `permissionMode: bypassPermissions`, `groupMode: off`
- Full file access, bash, builds, edits
- Only works in DM (ignores groups)
- **Use for:** personal coding assistant, build tasks, your own files

**💬 צ'אט בוט (chatbot)** — `permissionMode: plan`, `groupMode: mention`
- Read-only (can't edit anything)
- Responds in groups when @-tagged
- **Use for:** customer service, community Q&A, FAQ bot

---

## Files in the installation

```
~/claude-whatsapp-bot/
├── bot.js              # main bot (Node.js + Baileys)
├── index.html          # browser UI
├── config.json         # all settings
├── package.json
├── start.command       # double-click to run (Mac/Linux)
├── start.bat           # double-click to run (Windows)
├── README.md
├── .gitignore
├── auth/               # WhatsApp session (don't share!)
├── media/              # downloaded images/voice
├── feed.json           # last 60 messages
├── sessions.json       # per-user Claude session IDs
└── bot.log             # runtime log
```

---

## Closing the demo

After successful setup, ask if they want to:
1. **Add OpenAI key** for voice — walk them to platform.openai.com/api-keys
2. **Join a WhatsApp group** (chatbot mode) — they paste invite link
3. **Install on another user** — repeat the process (each user has their own install)

That's it. Don't over-engineer — the bot's UI handles all further customization.