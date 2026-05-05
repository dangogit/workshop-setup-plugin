#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES_FILE="$SCRIPT_DIR/rules.json"
TEMP_FILE=$(mktemp /tmp/email-agent-threads.XXXXXX.json)
trap "rm -f $TEMP_FILE" EXIT

echo "=== Email Agent Training ==="
echo "Fetching last 7 days of emails..."
echo ""

# Use claude to fetch emails
claude -p "
You have access to Gmail MCP tools. Do the following:

1. Use search_threads to fetch emails from the last 7 days: query 'newer_than:7d', pageSize 50
2. For each thread, output EXACTLY this JSON array format (no other text):

[
  {
    \"thread_id\": \"...\",
    \"from\": \"sender@example.com\",
    \"subject\": \"The subject line\",
    \"snippet\": \"First 100 chars of the email body...\"
  }
]

Output ONLY the JSON array, nothing else.
" > "$TEMP_FILE" 2>/dev/null

COUNT=$(python3 -c "import json; print(len(json.load(open('$TEMP_FILE'))))" 2>/dev/null) || {
  echo "Error: Could not fetch emails. Is Gmail MCP connected?"
  exit 1
}

echo "Found $COUNT threads. Let's classify them."
echo "For each email, enter: (i)mportant, (n)oise, or (s)kip"
echo "---"

python3 - "$TEMP_FILE" "$RULES_FILE" << 'PYEOF'
import json, sys

threads_file = sys.argv[1]
rules_file = sys.argv[2]

with open(threads_file) as f:
    threads = json.load(f)

with open(rules_file) as f:
    rules = json.load(f)

for i, t in enumerate(threads):
    print(f"\n[{i+1}/{len(threads)}]")
    print(f"  From:    {t['from']}")
    print(f"  Subject: {t['subject']}")
    print(f"  Snippet: {t.get('snippet', '')[:120]}")
    print()

    while True:
        choice = input("  Classify (i/n/s): ").strip().lower()
        if choice in ('i', 'n', 's'):
            break
        print("  Invalid. Enter i, n, or s.")

    if choice == 's':
        continue

    classification = "important" if choice == "i" else "noise"
    reason = input("  Brief reason (optional, Enter to skip): ").strip()

    rules['examples'].append({
        "from": t['from'],
        "subject": t['subject'],
        "snippet": t.get('snippet', '')[:120],
        "classification": classification,
        "reason": reason if reason else f"User classified as {classification}"
    })

    sender = t['from']
    if classification == "important" and sender not in rules['important_senders']:
        add = input(f"  Always mark {sender} as important? (y/n): ").strip().lower()
        if add == 'y':
            rules['important_senders'].append(sender)
    elif classification == "noise" and sender not in rules['noise_senders']:
        add = input(f"  Always mark {sender} as noise? (y/n): ").strip().lower()
        if add == 'y':
            rules['noise_senders'].append(sender)

with open(rules_file, 'w') as f:
    json.dump(rules, f, indent=2, ensure_ascii=False)

imp = len([e for e in rules['examples'] if e['classification'] == 'important'])
noise = len([e for e in rules['examples'] if e['classification'] == 'noise'])
print(f"\nTraining complete!")
print(f"  {imp} important examples, {noise} noise examples")
print(f"  {len(rules['important_senders'])} always-important senders")
print(f"  {len(rules['noise_senders'])} always-noise senders")
print(f"  Rules saved to rules.json")
PYEOF
