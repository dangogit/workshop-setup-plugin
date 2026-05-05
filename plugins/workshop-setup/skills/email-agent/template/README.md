# סוכן מיילים ל-Claude Code

סוכן מקומי שמתחבר ל-Gmail דרך Claude, קורא מיילים שלא נקראו, מסווג אותם ל-חשוב או רעש, ויוצר טיוטות תשובה למיילים חשובים.

הסוכן לא שולח מיילים. הוא רק יוצר טיוטות.

## מה צריך

- macOS
- Claude Code CLI
- Python 3
- curl
- Gmail מחובר ל-Claude
- Telegram bot או סוכן WhatsApp מקומי לקבלת סיכומים

## התקנה ראשונה

```bash
./setup.sh
```

הסקריפט ישאל:
- איך לקרוא לך
- לאיזה אימייל לשלוח סיכומי no-reply
- האם לשלוח סיכומים לטלגרם או וואטסאפ

אחר כך חבר Gmail:
- Claude.ai -> Settings -> Integrations -> Gmail -> Connect
- או בתוך Claude Code: `/mcp` ואז הוספת Gmail

אם Claude מבקש הרשאות, אשר את הכלים האלה:

```text
mcp__claude_ai_Gmail__search_threads
mcp__claude_ai_Gmail__get_thread
mcp__claude_ai_Gmail__create_draft
```

## בדיקת תקינות

```bash
./doctor.sh
```

זה בודק התקנה, קונפיג, Claude auth, Gmail MCP, ו-Telegram/WhatsApp. זה לא קורא מיילים ולא שולח הודעות.

## אימון הסוכן

```bash
./train.sh
```

תסמן מיילים אחרונים כ-חשוב או רעש. זה מעדכן את `rules.json`.

## בדיקה בטוחה

```bash
./agent.sh --dry-run
```

מצב dry-run קורא ומסווג מיילים, אבל:
- לא יוצר טיוטות
- לא מעדכן `state.json`
- לא מעדכן `stats.json`

זה המצב המומלץ לבדיקה ראשונה.

## ריצה אמיתית

```bash
./agent.sh
```

בריצה אמיתית הסוכן:
- מחפש מיילים שלא נקראו לפי `LOOKBACK_QUERY`
- מדלג על threads שכבר עובדו
- מסווג עד `MAX_THREADS` מיילים
- יוצר Gmail drafts למיילים חשובים
- שולח סיכום לטלגרם או וואטסאפ
- מעדכן `state.json`, `stats.json`, ו-`logs/`

## הרצה אוטומטית

רק אם רוצים שהסוכן ירוץ לבד במהלך היום:

```bash
./install-launchd.sh
```

הסרה:

```bash
./uninstall-launchd.sh
```

## קונפיג

הקובץ `.env` נוצר ב-setup. אפשר לערוך בו:

```bash
CLAUDE_MODEL=haiku
LOOKBACK_QUERY="is:unread newer_than:1d"
MAX_THREADS=20
FORWARD_TO_EMAIL=you@example.com
```

## דשבורד מקומי

```bash
python3 -m http.server 8787
```

ואז לפתוח:

```text
http://localhost:8787/dashboard/
```

## בטיחות

- הסוכן לא שולח מיילים
- הסוכן לא מוחק מיילים
- הסוכן לא עושה archive
- הסוכן לא מסמן מיילים כנקראו
- לוגים יכולים להכיל subjects וכתובות מייל, לא מפרסמים את `logs/`
- `.env`, `state.json`, `stats.json`, ו-`logs/` לא נכנסים לגיט
