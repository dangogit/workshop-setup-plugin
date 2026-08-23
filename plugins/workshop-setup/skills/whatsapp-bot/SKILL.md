---
name: whatsapp-bot
description: Install a local WhatsApp Claude agent for one-number self-chat, private groups, a separate bot number, or customer groups. Use when the user asks for a WhatsApp agent or to connect WhatsApp to Claude.
user-invocable: true
---

# WhatsApp Claude Agent

Install the local agent and guide the user through the browser wizard. The wizard, not the chat installer, chooses phone and group behavior. One install can hold more than one account (for example a personal number and a business number) side by side, each with its own settings, session and chat history.

## Design contract

`design.md` beside this file is the canonical visual system for the browser dashboard. Read it before changing `template/index.html` or the new `template/hub.html`. Keep the Apple-inspired restraint, typography, spacing, pill actions, and blue interaction rules while preserving the dashboard's Hebrew RTL behavior, accessibility, and existing functional states.

## Explain the result first

Tell the user:

> אתקין סוכן WhatsApp שרץ על המחשב שלך. אפשר להריץ יותר ממספר אחד במקביל, למשל מספר אישי ומספר עסקי, כל אחד עם הגדרות נפרדות. לכל מספר אפשר לעבוד עם מספר אחד בצ'אט עם עצמך או בקבוצה פרטית, עם מספר נפרד לבוט, או כבוט לקבוצה.

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

Ask only, for the account you are about to set up (the first one now, and again for each account you add later):

> איזו תיקייה תהיה נקודת הפתיחה של הסוכן? ברירת המחדל היא תיקיית הבית.

Explain that this is a starting directory, not an operating-system sandbox. In the full-access personal mode, Claude may access other files on the computer.

Do not ask for a phone number. Do not ask whether the user owns a second number. The browser wizard handles that.

## 3. Install

Template source is the `template/` folder beside this file. Installing now sets up the shared engine once: the hub (`hub.js`, `hub.html`, `lib/accounts.js`) alongside the per-account runtime (`bot.js`, `index.html`, `lib/bot-core.js`, `lib/http-core.js`). No account exists yet after this step - accounts live under `accounts/<id>/` and are created in step 4.

The template ships a default `config.json`, but on a reinstall or update over an existing **single-account** install, the top-level `config.json` (and `auth/`, `feed.json`, `sessions.json`, `media/`, `bot.log`, and the two `*-message-ids.json` files, if present) hold the user's real settings, WhatsApp session, and OpenAI API key. Preserve `config.json` across the copy exactly as before: back it up before copying the template over it and restore it after. Leave the other legacy files where they are - do not move them into `accounts/main/` yourself. The hub adopts all of them automatically the first time it starts (step 5), and it never deletes anything in the process.

macOS or Linux:

```bash
INSTALL="$HOME/claude-whatsapp-bot"
mkdir -p "$INSTALL"
[ -f "$INSTALL/config.json" ] && cp "$INSTALL/config.json" "$INSTALL/config.json.keep"
cp -R "<SKILL_DIR>/template/." "$INSTALL/"
[ -f "$INSTALL/config.json.keep" ] && mv "$INSTALL/config.json.keep" "$INSTALL/config.json"
chmod +x "$INSTALL/start.command"
cd "$INSTALL"
npm install --ignore-scripts --no-fund --no-audit
```

Windows PowerShell:

```powershell
$INSTALL = "$env:USERPROFILE\claude-whatsapp-bot"
New-Item -ItemType Directory -Force -Path $INSTALL | Out-Null
$cfg = Join-Path $INSTALL 'config.json'; $keep = "$cfg.keep"
if (Test-Path $cfg) { Copy-Item $cfg $keep -Force }
Copy-Item -Recurse -Force "<SKILL_DIR>\template\*" -Destination $INSTALL
if (Test-Path $keep) { Move-Item $keep $cfg -Force }
Set-Location $INSTALL
npm install --ignore-scripts --no-fund --no-audit
```

Every npm install in this workflow must keep `--ignore-scripts`.

Preserving an old `config.json` is safe for most fields: `normalizeConfig` fills in the default for anything missing at load time. Two fields are the exception. `allowAllLegacyGroups` does not fall back to its `DEFAULT_CONFIG` value (`false`) when the key is absent - it becomes `true` instead whenever `allowedChats` was also never set and `groupMode` is already a non-off value, which is exactly the shape of a config saved before `allowAllLegacyGroups` existed. `onboardingComplete` does the same: when the key is absent it becomes `true`, not `false`, as soon as `ownerNumber` is already set. Both are deliberate migration inference inside `normalizeConfig` (`lib/bot-core.js`, around lines 114-116), not bugs - but an old file's silence on these two keys can silently grant group access or skip onboarding. Check the loaded booleans themselves rather than assuming an absent key means the conservative default.

## 4. Create the account and configure its directory

Accounts live under `accounts/<id>/`. Pick an id from the account name using lowercase ascii letters, digits and hyphens (`^[a-z0-9][a-z0-9-]{0,31}$`, no `..`, no `/`); for a Hebrew or otherwise non-ascii name, fall back to `account-1`, `account-2`, ... instead.

Create `accounts/<id>/` with an `auth/` subfolder, then write `accounts/<id>/config.json`, seeded from the template default with only `agentName` and `workdir` filled in and `onboardingComplete` left `false`:

```json
{
  "agentName": "<NAME>",
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

For the first account this is usually `accounts/main/`. An account added later straight from the hub UI (name only - the hub does not ask a directory question) gets the same file with `workdir` left empty; it falls back to the home directory at runtime, and the user can change it afterwards from that account's own dashboard settings.

## 5. Launch and verify

macOS or Linux:

```bash
WA_LAUNCH_SILENT=1 nohup bash "$INSTALL/start.command" > "$INSTALL/launcher.log" 2>&1 &
```

Windows:

```powershell
Start-Process "$INSTALL\start.bat"
```

The launcher now starts the hub, not a single bot directly. The hub listens on port 7654 and starts (or supervises) one child `bot.js` process per account, each on its own port (7655, 7656, ...), passing it `WA_ACCOUNT_DIR` and `PORT` through the environment.

The first time the hub starts, it checks for a legacy top-level `config.json`. If one is there (preserved in step 3), it moves it - together with `auth/`, `feed.json`, `sessions.json`, `media/`, `bot.log`, and the two `*-message-ids.json` files - into `accounts/main/` automatically. This is idempotent and non-destructive: it does nothing on a run where there is nothing to adopt, it never overwrites an existing account, and it never deletes anything it did not move.

Verify:

```bash
curl -fsS http://127.0.0.1:7654/api/accounts
```

The server needs a few seconds to start. If curl fails, wait 5 seconds and retry up to 3 times before reading the logs. The response is `{"accounts": [...]}` - one entry per account (empty on a brand-new install where nothing was adopted and none has been created yet).

## 6. Walk the user through the hub and wizard

The user lands on the hub first, at `http://127.0.0.1:7654`. Tell them this page lists every account on this Mac, shows whether each is running, and lets them start, stop, or remove one. Once an account is configured, the hub also shows who it is listening to (עצמי / קבוצה פרטית / פרטי) in Hebrew.

To add an account:

1. Enter the account name and create it. (For the very first account, or one you are scripting on the user's behalf, create it directly per step 4 instead, so you can also set its working directory up front.)
2. Open that account's own dashboard from the hub - its own port, not 7654.
3. Scan the QR through WhatsApp, Settings, Linked devices, Link a device.
4. Answer the wizard one question at a time:
   - First choose whether the connected number is the user's regular number or a dedicated bot number.
   - Regular number: choose self-chat or one private group. No pairing code and no second SIM. The home screen keeps this destination switch available after setup.
   - Dedicated bot number: choose private owner use or one explicit group. Private use starts owner pairing; group use selects the group and then pairs the owner.
5. Send a short test message in the selected chat.

Never tell a one-number user to pair a second phone. Never tell a user that all groups are enabled. Group access is explicit. Keep onboarding progressive: ask which number was connected, then ask where to talk. Never present all technical modes at once.

Each account is independent. A second account (a second personal or business number) goes through the same five steps on its own dashboard and never touches the first account's session, config, or chat history.

## 7. Verify the real result

Get the account's port from the hub, then check that account directly:

```bash
curl -fsS http://127.0.0.1:7654/api/accounts | python3 -c "import json,sys;a=[x for x in json.load(sys.stdin)['accounts'] if x['id']=='<ID>'][0];print(a['port'],a['status'])"
curl -fsS http://127.0.0.1:<PORT>/state | python3 -c "import json,sys;s=json.load(sys.stdin);print(s['status'],s['config']['onboardingComplete'],s['config']['singleNumberMode'],s['config']['allowedChats'],s['stats'])"
```

Done means, for that one account:

- `status` is `connected`.
- `onboardingComplete` is true.
- The listening target matches the user's choice.
- A real test message increased `messagesIn` and produced one reply.

Verify each account separately. A green result on one account says nothing about another account's connection state.

## Troubleshooting

| Problem | Action |
|---|---|
| Hub dashboard does not open | Open `http://127.0.0.1:7654`, then inspect `$INSTALL/launcher.log`. |
| An account's dashboard does not open | Open its port from the hub's list, then inspect `$INSTALL/accounts/<id>/bot.log`. |
| Port 7654 is occupied | Identify the process. The launcher intentionally does not kill unrelated processes. |
| An account's own port is occupied | Each account gets `7655 + index`. If that port belongs to something unrelated, free it or stop that other process before starting the account from the hub. |
| Claude is not ready | Run `claude --version`, then reinstall Claude Code with `--ignore-scripts` if needed. |
| QR or session fails | Use "סריקה מחדש" on that account's dashboard and scan a new QR. |
| One-number message gets no reply | Confirm self-chat or the exact selected group is shown under "מקשיב" on that account's dashboard. |
| Group participant gets no reply | Confirm the group is enabled and the participant tagged the bot in mention mode. |
| Owner pairing fails | Send only the six-digit code in a direct message from the personal number. |
| Need a clean reset of one account | On that account's dashboard: Settings, Privacy, "מחק את כל הנתונים המקומיים". This clears only that account's local data. |
| Need to remove an account entirely | Stop it, then delete it from the hub. This removes `accounts/<id>/` completely; other accounts are untouched. |

## Safety boundaries

- Full-access personal mode can execute commands and modify files across the computer. The workdir is not a sandbox.
- Customer/group mode uses limited Claude permissions and only selected groups.
- The hub and every account's dashboard listen only on `127.0.0.1` and protect mutations with a per-run token.
- Each account's auth data, recent feed, sessions, logs, downloaded media, and optional API key are stored locally under its own `accounts/<id>/` directory - kept separate from every other account by directory only, not by any stronger isolation - until the user deletes them.
- For production customer messaging, recommend the official WhatsApp Business Platform instead of this unofficial bridge.
