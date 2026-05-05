#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
TIMESTAMP=$(date +"%Y-%m-%d-%H-%M")
LOG_FILE="$LOG_DIR/$TIMESTAMP.log"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: ./agent.sh [--dry-run]

Options:
  --dry-run   Classify emails and report what would happen without creating drafts or updating state.
  -h, --help  Show this help.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[$TIMESTAMP] Email agent starting in dry-run mode..." | tee "$LOG_FILE"
else
  echo "[$TIMESTAMP] Email agent starting..." | tee "$LOG_FILE"
fi

# Load env
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "Missing .env. Run ./setup.sh first." | tee -a "$LOG_FILE"
  exit 1
fi
source "$SCRIPT_DIR/.env"

USER_NAME="${USER_NAME:-Email Agent User}"
FORWARD_TO_EMAIL="${FORWARD_TO_EMAIL:-}"
CLAUDE_MODEL="${CLAUDE_MODEL:-haiku}"
LOOKBACK_QUERY="${LOOKBACK_QUERY:-is:unread newer_than:1d}"
MAX_THREADS="${MAX_THREADS:-20}"

if [ -z "$FORWARD_TO_EMAIL" ]; then
  echo "FORWARD_TO_EMAIL must be set in .env. Run ./setup.sh or edit .env." | tee -a "$LOG_FILE"
  exit 1
fi

case "$MAX_THREADS" in
  ''|*[!0-9]*)
    echo "MAX_THREADS must be a positive integer." | tee -a "$LOG_FILE"
    exit 1
    ;;
esac
if [ "$MAX_THREADS" -lt 1 ]; then
  echo "MAX_THREADS must be greater than zero." | tee -a "$LOG_FILE"
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/state.json" ]; then
  printf '{\n  "last_run": null,\n  "last_processed_thread_id": null,\n  "processed_thread_ids": [],\n  "total_processed": 0\n}\n' > "$SCRIPT_DIR/state.json"
fi

if [ ! -f "$SCRIPT_DIR/stats.json" ]; then
  printf '{\n  "runs": [],\n  "top_senders": {\n    "important": {},\n    "noise": {}\n  },\n  "totals": {\n    "total_processed": 0,\n    "total_important": 0,\n    "total_noise": 0,\n    "total_drafts": 0\n  }\n}\n' > "$SCRIPT_DIR/stats.json"
fi

# Build the prompt by reading rules.json and tone-examples.md into context
RULES=$(cat "$SCRIPT_DIR/rules.json")
TONE=$(cat "$SCRIPT_DIR/tone-examples.md")
STATE=$(cat "$SCRIPT_DIR/state.json")
PROMPT=$(cat "$SCRIPT_DIR/prompt.md")
json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}
USER_NAME_JSON=$(printf '%s' "$USER_NAME" | json_escape)
FORWARD_TO_EMAIL_JSON=$(printf '%s' "$FORWARD_TO_EMAIL" | json_escape)
LOOKBACK_QUERY_JSON=$(printf '%s' "$LOOKBACK_QUERY" | json_escape)
if [ "$DRY_RUN" -eq 1 ]; then
  DRY_RUN_JSON=true
else
  DRY_RUN_JSON=false
fi

FULL_PROMPT="$PROMPT

## Current user config:
{
  \"user_name\": $USER_NAME_JSON,
  \"forward_to_email\": $FORWARD_TO_EMAIL_JSON,
  \"dry_run\": $DRY_RUN_JSON,
  \"query\": $LOOKBACK_QUERY_JSON,
  \"max_threads\": $MAX_THREADS
}

## Current rules.json content:
$RULES

## Current tone-examples.md content:
$TONE

## Current state.json content:
$STATE"

# Run Claude with Gmail MCP
echo "Running claude -p..." | tee -a "$LOG_FILE"
START_TIME=$(date +%s)

JSON_SCHEMA='{
  "type": "object",
  "additionalProperties": true,
  "properties": {
    "processed": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "thread_id": { "type": "string" },
          "from": { "type": "string" },
          "subject": { "type": "string" },
          "classification": { "type": "string", "enum": ["important", "noise"] },
          "draft_created": { "type": "boolean" },
          "would_create_draft": { "type": "boolean" }
        },
        "required": ["thread_id", "from", "subject", "classification", "draft_created"]
      }
    },
    "summary": {
      "type": "object",
      "properties": {
        "total": { "type": "integer" },
        "important": { "type": "integer" },
        "noise": { "type": "integer" },
        "drafts_created": { "type": "integer" }
      },
      "required": ["total", "important", "noise", "drafts_created"]
    },
    "error": { "type": "string" }
  },
  "required": ["processed", "summary"]
}'

CLAUDE_ARGS=(-p "$FULL_PROMPT" --model "$CLAUDE_MODEL")
if claude --help 2>/dev/null | grep -q -- "--json-schema"; then
  CLAUDE_ARGS+=(--json-schema "$JSON_SCHEMA")
fi

RAW_RESULT=$(claude "${CLAUDE_ARGS[@]}" 2>>"$LOG_FILE") || {
  if [ -n "${RAW_RESULT:-}" ]; then
    echo "Claude output before failure:" >> "$LOG_FILE"
    echo "$RAW_RESULT" >> "$LOG_FILE"
  fi
  echo "[$TIMESTAMP] Claude failed" | tee -a "$LOG_FILE"
  "$SCRIPT_DIR/notify.sh" "Email Agent ERROR: Claude failed at $TIMESTAMP. Check logs."
  exit 1
}

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "Claude output:" >> "$LOG_FILE"
echo "$RAW_RESULT" >> "$LOG_FILE"

# Extract and validate JSON from Claude's output (may be wrapped in markdown code blocks).
RESULT=$(printf '%s' "$RAW_RESULT" | python3 -c "
import json
import sys

text = sys.stdin.read()

for start, char in enumerate(text):
    if char != '{':
        continue

    depth = 0
    in_string = False
    escaped = False

    for end in range(start, len(text)):
        current = text[end]

        if in_string:
            if escaped:
                escaped = False
            elif current == '\\\\':
                escaped = True
            elif current == '\"':
                in_string = False
            continue

        if current == '\"':
            in_string = True
        elif current == '{':
            depth += 1
        elif current == '}':
            depth -= 1
            if depth == 0:
                candidate = text[start:end + 1]
                try:
                    parsed = json.loads(candidate)
                except json.JSONDecodeError:
                    break

                if isinstance(parsed, dict) and 'summary' in parsed:
                    print(json.dumps(parsed, ensure_ascii=False))
                    sys.exit(0)
                break

sys.exit(1)
" 2>>"$LOG_FILE") || {
  echo "[$TIMESTAMP] Could not parse Claude JSON output" | tee -a "$LOG_FILE"
  "$SCRIPT_DIR/notify.sh" "Email Agent ERROR: Could not parse Claude JSON output at $TIMESTAMP. Check logs."
  exit 1
}

# Parse the JSON result
TOTAL=$(printf '%s' "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary']['total'])" 2>/dev/null) || TOTAL=0
IMPORTANT=$(printf '%s' "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary']['important'])" 2>/dev/null) || IMPORTANT=0
NOISE=$(printf '%s' "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary']['noise'])" 2>/dev/null) || NOISE=0
DRAFTS=$(printf '%s' "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary']['drafts_created'])" 2>/dev/null) || DRAFTS=0

# Update runtime files only in live mode. Dry-run should not mark emails as processed.
if [ "$DRY_RUN" -eq 0 ]; then
  # Update state.json with processed thread IDs
  printf '%s' "$RESULT" | python3 -c "
import json, sys

try:
    result = json.load(sys.stdin)
except:
    sys.exit(0)

with open('$SCRIPT_DIR/state.json', 'r') as f:
    state = json.load(f)

new_ids = [e['thread_id'] for e in result.get('processed', [])]
processed = state.get('processed_thread_ids', [])
for thread_id in new_ids:
    if thread_id not in processed:
        processed.append(thread_id)
state['processed_thread_ids'] = processed[-200:]
state['last_run'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
state['total_processed'] = state.get('total_processed', 0) + len(new_ids)
if new_ids:
    state['last_processed_thread_id'] = new_ids[-1]

with open('$SCRIPT_DIR/state.json', 'w') as f:
    json.dump(state, f, indent=2)
" 2>>"$LOG_FILE"

  # Update stats.json
  printf '%s' "$RESULT" | python3 -c "
import json, sys

result = json.load(sys.stdin)

with open('$SCRIPT_DIR/stats.json', 'r') as f:
    stats = json.load(f)

stats['runs'].append({
    'timestamp': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'total_emails': $TOTAL,
    'important': $IMPORTANT,
    'noise': $NOISE,
    'drafts_created': $DRAFTS,
    'duration_seconds': $DURATION
})
stats['runs'] = stats['runs'][-100:]

stats['totals']['total_processed'] += $TOTAL
stats['totals']['total_important'] += $IMPORTANT
stats['totals']['total_noise'] += $NOISE
stats['totals']['total_drafts'] += $DRAFTS

for entry in result.get('processed', []):
    sender = entry.get('from', 'unknown')
    cls = entry.get('classification', 'noise')
    bucket = stats['top_senders'].get(cls, {})
    bucket[sender] = bucket.get(sender, 0) + 1
    stats['top_senders'][cls] = bucket

with open('$SCRIPT_DIR/stats.json', 'w') as f:
    json.dump(stats, f, indent=2)
" 2>>"$LOG_FILE"
else
  echo "Dry run: state.json and stats.json were not updated." >> "$LOG_FILE"
fi

# Build Telegram message
if [ "$DRY_RUN" -eq 1 ]; then
  MSG_TITLE="--- Email Agent DRY RUN ---"
  DETAIL_LABEL="Would create draft"
else
  MSG_TITLE="--- Email Agent Report ---"
  DETAIL_LABEL="Draft ready in Gmail"
fi

if [ "$IMPORTANT" -gt 0 ]; then
  DETAILS=$(printf '%s' "$RESULT" | DETAIL_LABEL="$DETAIL_LABEL" python3 -c "
import json, os, sys
d = json.load(sys.stdin)
label = os.environ.get('DETAIL_LABEL', 'Draft ready in Gmail')
lines = []
i = 1
for e in d.get('processed', []):
    if e.get('classification') == 'important':
        lines.append(f\"{i}. From: {e['from']}\n   Subject: {e['subject']}\n   {label}\")
        i += 1
print('\n\n'.join(lines))
" 2>/dev/null)

  MSG="$MSG_TITLE
$IMPORTANT important emails found:

$DETAILS

$NOISE noise emails filtered.
Duration: ${DURATION}s"
else
  MSG="$MSG_TITLE
No important emails found.
$NOISE noise emails filtered.
Duration: ${DURATION}s"
fi

"$SCRIPT_DIR/notify.sh" "$MSG"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[$TIMESTAMP] Dry run done. $TOTAL processed, $IMPORTANT important, $NOISE noise, 0 drafts created." | tee -a "$LOG_FILE"
else
  echo "[$TIMESTAMP] Done. $TOTAL processed, $IMPORTANT important, $DRAFTS drafts." | tee -a "$LOG_FILE"
fi
