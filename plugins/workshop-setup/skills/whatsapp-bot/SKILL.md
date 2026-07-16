---
name: whatsapp-bot
description: Install a local WhatsApp Claude agent for one-number self-chat, private groups, a separate bot number, or customer groups. Use when the user asks for a WhatsApp agent or to connect WhatsApp to Claude.
user-invocable: true
---

# WhatsApp Claude Agent

Install the local agent and guide the user through the browser wizard. The wizard, not the chat installer, chooses phone and group behavior.

## Design contract

`design.md` beside this file is the canonical visual system for the browser dashboard. Read it before changing `template/index.html`. Keep the Apple-inspired restraint, typography, spacing, pill actions, and blue interaction rules while preserving the dashboard's Hebrew RTL behavior, accessibility, and existing functional states.

## Explain the result first

Tell the user:

> אתקין סוכן WhatsApp שרץ על המחשב שלך. אפשר לעבוד עם מספר אחד בצ'אט עם עצמך או בקבוצה פרטית, עם מספר נפרד לבוט, או כבוט לקבוצה.

Also state that the connection uses Baileys, an unofficial WhatsApp Web library. It may require rescanning after WhatsApp changes and should not be treated as an official Business API integration.

## 1. Pre-flight

Detect the platform and use the matching check.

macOS or Linux:

```bash
node --version 2>/dev/null || echo "MISSING:node"
command -v claude >/dev/null && echo "claude:OK" || echo "MISSING:claude"
```

Windows PowerShell:

```powershell
node --version
if (Get-Command claude -ErrorAction SilentlyContinue) { "claude:OK" } else { "MISSING:claude" }
```

Requirements:

- Node.js 20.9 or newer.
- Claude Code CLI. If missing, install with `npm install --ignore-scripts -g @anthropic-ai/claude-code`.

Do not continue until both are available.

## 2. Ask one question

Ask only:

> איזו תיקייה תהיה נקודת הפתיחה של הסוכן? ברירת המחדל היא תיקיית הבית.

Explain that this is a starting directory, not an operating-system sandbox. In the full-access personal mode, Claude may access other files on the computer.

Do not ask for a phone number. Do not ask whether the user owns a second number. The browser wizard handles that.

## 3. Install

Template source is the `template/` folder beside this file.

macOS or Linux:

```bash
INSTALL="$HOME/claude-whatsapp-bot"
mkdir -p "$INSTALL/auth"
cp -R "<SKILL_DIR>/template/." "$INSTALL/"
chmod +x "$INSTALL/start.command"
cd "$INSTALL"
npm install --ignore-scripts --no-fund --no-audit
```

Windows PowerShell:

```powershell
$INSTALL = "$env:USERPROFILE\claude-whatsapp-bot"
New-Item -ItemType Directory -Force -Path "$INSTALL\auth" | Out-Null
Copy-Item -Recurse -Force "<SKILL_DIR>\template\*" -Destination $INSTALL
Set-Location $INSTALL
npm install --ignore-scripts --no-fund --no-audit
```

Every npm install in this workflow must keep `--ignore-scripts`.

## 4. Configure the starting directory

Update only `workdir` in `config.json`. Keep first-run fields empty:

```json
{
  "agentName": "הסוכן שלי",
  "workdir": "<WORKDIR>",
  "model": "sonnet",
  "whitelist": [],
  "ownerNumber": "",
  "singleNumberMode": false,
  "allowedChats": [],
  "allowAllLegacyGroups": false,
  "onboardingComplete": false,
  "publicMode": false,
  "groupPublicMode": false,
  "groupMode": "off",
  "permissionMode": "bypassPermissions",
  "systemPromptAppend": "",
  "openaiApiKey": "",
  "ttsMode": "mirror",
  "ttsVoice": "alloy"
}
```

## 5. Launch and verify

macOS or Linux:

```bash
WA_LAUNCH_SILENT=1 nohup bash "$INSTALL/start.command" > "$INSTALL/launcher.log" 2>&1 &
```

Windows:

```powershell
Start-Process "$INSTALL\start.bat"
```

Verify:

```bash
curl -fsS http://127.0.0.1:7654/doctor
```

The server needs a few seconds to start. If curl fails, wait 5 seconds and retry up to 3 times before reading the logs.

The response must show Node, Claude, config, storage, and WhatsApp checks. WhatsApp may still be waiting for QR at this point.

## 6. Walk the user through the wizard

Open `http://127.0.0.1:7654` and tell the user:

1. Scan the QR through WhatsApp, Settings, Linked devices, Link a device.
2. Answer the wizard one question at a time:
   - First choose whether the connected number is the user's regular number or a dedicated bot number.
   - Regular number: choose self-chat or one private group. No pairing code and no second SIM. The home screen keeps this destination switch available after setup.
   - Dedicated bot number: choose private owner use or one explicit group. Private use starts owner pairing; group use selects the group and then pairs the owner.
3. Send a short test message in the selected chat.

Never tell a one-number user to pair a second phone. Never tell a user that all groups are enabled. Group access is explicit.
Keep onboarding progressive: ask which number was connected, then ask where to talk. Never present all technical modes at once.

## 7. Verify the real result

```bash
curl -fsS http://127.0.0.1:7654/state | python3 -c "import json,sys;s=json.load(sys.stdin);print(s['status'],s['config']['onboardingComplete'],s['config']['singleNumberMode'],s['config']['allowedChats'],s['stats'])"
```

Done means:

- `status` is `connected`.
- `onboardingComplete` is true.
- The listening target matches the user's choice.
- A real test message increased `messagesIn` and produced one reply.

## Troubleshooting

| Problem | Action |
|---|---|
| Dashboard does not open | Open `http://127.0.0.1:7654`, then inspect `$INSTALL/launcher.log` and `$INSTALL/bot.log`. |
| Port 7654 is occupied | Identify the process. The launcher intentionally does not kill unrelated processes. |
| Claude is not ready | Run `claude --version`, then reinstall Claude Code with `--ignore-scripts` if needed. |
| QR or session fails | Use "סריקה מחדש" and scan a new QR. |
| One-number message gets no reply | Confirm self-chat or the exact selected group is shown under "מקשיב". |
| Group participant gets no reply | Confirm the group is enabled and the participant tagged the bot in mention mode. |
| Owner pairing fails | Send only the six-digit code in a direct message from the personal number. |
| Need a clean reset | Settings, Privacy, "מחק את כל הנתונים המקומיים". |

## Safety boundaries

- Full-access personal mode can execute commands and modify files across the computer. The workdir is not a sandbox.
- Customer/group mode uses limited Claude permissions and only selected groups.
- The local dashboard listens only on `127.0.0.1` and protects mutations with a per-run token.
- Auth data, recent feed, sessions, logs, downloaded media, and optional API keys are stored locally until the user deletes them.
- For production customer messaging, recommend the official WhatsApp Business Platform instead of this unofficial bridge.
