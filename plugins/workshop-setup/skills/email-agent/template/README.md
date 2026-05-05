# Email Agent

AI email triage agent for Claude Code. It reads unread Gmail messages, classifies them as important or noise, drafts replies for important messages, and sends a Telegram or WhatsApp summary.

The agent never sends emails. It only creates Gmail drafts.

## Requirements

- macOS
- Claude Code CLI
- Python 3
- curl
- Gmail connected to Claude
- Telegram bot token or a local WhatsApp bot

## Quick Start

1. Clone or download this project.
2. Run setup:
   ```bash
   ./setup.sh
   ```
3. Connect Gmail:
   - Claude.ai: Settings -> Integrations -> Gmail -> Connect
   - Claude Code: `/mcp` -> Add Integration -> Gmail
4. Allow the Gmail tools in Claude Code if prompted:
   ```text
   mcp__claude_ai_Gmail__search_threads
   mcp__claude_ai_Gmail__get_thread
   mcp__claude_ai_Gmail__create_draft
   ```
5. Train the classifier:
   ```bash
   ./train.sh
   ```
6. Run a manual test:
   ```bash
   ./agent.sh
   ```

## Optional Scheduling

Install the macOS LaunchAgent schedule:

```bash
./install-launchd.sh
```

This runs the agent at 8:00, 10:00, 12:00, 14:00, 16:00, and 18:00.

Remove the schedule:

```bash
./uninstall-launchd.sh
```

## Project Structure

```text
email-agent/
├── setup.sh              One-time setup
├── agent.sh              Main agent runner
├── train.sh              Interactive classifier training
├── notify.sh             Telegram or WhatsApp notifications
├── telegram.sh           Direct Telegram helper
├── install-launchd.sh    Optional macOS schedule installer
├── uninstall-launchd.sh  Schedule remover
├── prompt.md             Agent instructions
├── rules.json            Sender lists and examples
├── tone-examples.md      Reply style examples
├── dashboard/            Local dashboard
└── logs/                 Generated run logs
```

Generated local files are ignored by Git: `.env`, `state.json`, `stats.json`, `logs/`, and the generated LaunchAgent plist.

## Customization

- Edit `tone-examples.md` to match your writing style.
- Edit `rules.json` to add important or noisy senders.
- Change `CLAUDE_MODEL` in `.env` if you want a different Claude model.
- Run `./train.sh` again anytime to add examples.

## Safety Notes

- The agent creates drafts only. It does not send, delete, archive, or mark emails as read.
- `.env`, `state.json`, `stats.json`, and `logs/` are local files and ignored by Git.
- Logs may contain email subjects and sender addresses. Do not publish the `logs/` folder.
- Each user must connect their own Gmail account through Claude.

## Dashboard

```bash
python3 -m http.server 8787
```

Open http://localhost:8787/dashboard/
