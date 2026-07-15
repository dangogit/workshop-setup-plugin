# WhatsApp Bot V2 Hardening Plan

**Goal:** Turn the workshop WhatsApp bot from a technical demo into a reliable, understandable product that supports a single WhatsApp number, private groups, separate bot numbers, and customer groups without message loops or cross-chat memory leaks.

**Scope:** `plugins/workshop-setup/skills/whatsapp-bot/` only. Existing unrelated changes, including the root `.DS_Store`, must remain untouched.

**Release rule:** Each task is one focused commit. After implementation, run a spec review and a code-quality review, fix findings, and complete a final full-branch review before push.

## Product contract

The first-run experience asks what the user wants to achieve, not which internal flags to set:

1. **One number:** the connected WhatsApp account is the owner. The owner can talk to Claude in the WhatsApp self-chat or in explicitly selected private groups.
2. **Separate bot number:** the connected account is the bot account. The owner pairs a different number and talks by direct message.
3. **Group/customer bot:** the bot responds only in explicitly enabled groups, with safe chatbot permissions and configurable mention/always behavior.

The bot must never respond recursively to messages it generated itself.

## Acceptance matrix

| Scenario | Expected behavior |
|---|---|
| Owner sends a message in WhatsApp self-chat | Process once and reply once |
| Owner sends a message in an enabled private group | Process once and reply to that group |
| Bot reply is echoed back as `fromMe` | Ignore it, with no recursive reply |
| Owner sends in a group that is not enabled | Ignore it |
| Other participant sends in an enabled owner-only group | Block it unless explicitly whitelisted |
| Mention-mode participant mentions the bot in an enabled group | Process it |
| Participant sends without a mention in mention mode | Ignore it |
| Duplicate WhatsApp event arrives after reconnect | Process it at most once |
| Two messages arrive quickly in the same chat | Process in order through one queue |
| Messages arrive in two different chats | Use separate Claude sessions |
| Public user sends an owner-only slash command | Reject it |
| Config update contains an invalid work directory or invalid mode | Reject it without corrupting the existing config |
| UI is rendered at 390px width | No horizontal clipping or overflow |
| First-run user has one number | Can complete setup without typing a phone number or sending a pairing code from a second account |

## Task 1: Message routing and reliability core

Files:

- Add `template/lib/bot-core.js`
- Add `template/test/bot-core.test.js`
- Modify `template/bot.js`
- Modify `template/config.json`
- Modify `template/.gitignore`

Implementation:

- Normalize and validate configuration with backward-compatible defaults.
- Add `singleNumberMode`, `ownerNumber`, `allowedChats`, and `onboardingComplete`.
- Accept owner-authored `fromMe` messages only in self-chat or explicitly allowed chats.
- Track outbound message IDs and ignore their echoes.
- Persist recently processed inbound IDs for duplicate protection across reconnects.
- Serialize Claude work per conversation while allowing separate chats to run independently.
- Key sessions and working directories by conversation, not only sender.
- Restrict state-changing slash commands to the owner.
- Add `/cancel` for the active task in the current conversation.
- Write config/state atomically and bound retained IDs.

Verification:

```bash
node --test plugins/workshop-setup/skills/whatsapp-bot/template/test/*.test.js
node --check plugins/workshop-setup/skills/whatsapp-bot/template/bot.js
```

## Task 2: Goal-based onboarding and group selection

Files:

- Modify `template/index.html`
- Modify `template/bot.js`

Implementation:

- Add a first-run wizard for one number, separate bot number, and group/customer bot.
- Auto-detect the connected account and offer one-click owner authorization.
- Let users select the self-chat or specific groups instead of enabling all groups globally.
- Show which chats the bot is listening to and why it will or will not respond.
- Keep advanced technical settings available but secondary.
- Replace non-actionable dashboard emphasis with connection, Claude health, listening target, and last activity.
- Add local mutation protection for the browser UI and validate request bodies.

Verification:

```bash
node --test plugins/workshop-setup/skills/whatsapp-bot/template/test/*.test.js
node --check plugins/workshop-setup/skills/whatsapp-bot/template/bot.js
```

Manual UI checks:

- Desktop at 1440x1000.
- Mobile at 390x844.
- Wizard state before connection, after connection, after selecting self-chat, and after selecting a group.

## Task 3: Responsive polish and operational clarity

Files:

- Modify `template/index.html`
- Modify `template/README.md`
- Modify `SKILL.md`
- Modify `template/start.command`
- Modify `template/start.bat`

Implementation:

- Add responsive layouts for header, tabs, mode cards, buttons, stats, settings, modals, and group rows.
- Replace internal jargon in primary flows with plain Hebrew.
- Explain that `workdir` is a starting directory, not an OS sandbox in full-access mode.
- Add a visible data-retention/privacy section and a delete-local-data action.
- Add a doctor endpoint and UI status for Node, Claude CLI, config, WhatsApp, and writable storage.
- Use a scoped PID file instead of broad process killing where possible.
- Update installation and troubleshooting instructions for all three setup modes.

Verification:

```bash
bash -n plugins/workshop-setup/skills/whatsapp-bot/template/start.command
node --test plugins/workshop-setup/skills/whatsapp-bot/template/test/*.test.js
```

## Task 4: Supported dependency line and release verification

Files:

- Modify `template/package.json`
- Add `template/package-lock.json`
- Modify `template/bot.js`
- Modify `SKILL.md`
- Modify `template/README.md`

Implementation:

- Upgrade to the supported Baileys 7 release line and Node 20+.
- Remove per-start latest WhatsApp version fetching.
- Choose the browser identity for macOS, Windows, or Linux.
- Add cached group metadata.
- Keep `--ignore-scripts` on every workshop install command.
- Pin the dependency graph with a lockfile.

Verification:

```bash
cd plugins/workshop-setup/skills/whatsapp-bot/template
npm install --ignore-scripts --no-fund --no-audit
npm test
node --check bot.js
```

## Task 5: Full release audit

Review the complete diff against every row of the acceptance matrix. Confirm:

- No unrelated file is staged.
- No secret, auth state, message history, media, or local config is committed.
- Existing installs receive backward-compatible defaults.
- One-number setup does not require a second account.
- A bot-generated reply cannot trigger another Claude run.
- Group access is explicit and per-chat.
- Mobile screenshots have no horizontal clipping.
- Documentation matches the implemented behavior.
- The submodule commit is pushed to `origin/main`.
- The parent repo points at the pushed submodule commit in a separate focused commit, without staging unrelated parent changes.
