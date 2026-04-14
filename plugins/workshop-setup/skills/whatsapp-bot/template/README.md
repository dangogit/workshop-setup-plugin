# 🤖 WhatsApp ↔ Claude Bot

סוכן AI אישי שרץ על המחשב שלך ומחובר ל-WhatsApp. שולחים הודעה מהטלפון → Claude מעבד עם גישה לקבצים שלך → תשובה חוזרת בווטסאפ.

## 🚀 הפעלה

- **Mac:** double-click על `start.command` (או הקיצור בשולחן העבודה)
- **Windows:** double-click על `start.bat`
- **Linux:** `bash start.command`

הדפדפן ייפתח ב-**http://localhost:7654**.

## 📱 הגדרה ראשונה (פעם אחת)

1. **סרוק QR** — WhatsApp בטלפון → הגדרות → מכשירים מקושרים → קישור מכשיר.
2. **חבר את המספר שלך** — לחץ **"📱 חבר טלפון"**. יופיע קוד. שלח אותו מהטלפון שלך → המספר נוסף ל-whitelist.
3. **בחר מצב** — בטאב "הגדרות":
   - **🧑‍💻 עוזר אישי** — הסוכן עושה הכל (עריכה, bash, בנייה). רק אתה.
   - **💬 צ'אט בוט** — קריאה בלבד, קבוצות, תגובה רק ב-@.

שלח הודעה → תקבל תשובה.

## 🎤 תמיכה בקול (אופציונלי)

מוסיפים OpenAI API key בהגדרות:
1. לחץ "🔑 קבל מפתח" → https://platform.openai.com/api-keys
2. הירשם, צור מפתח, העתק (`sk-...`)
3. הדבק בדף ההגדרות → שמור

מעכשיו: voice note → תמלול Whisper → Claude → תשובה (גם קולית במצב "חכם").

## 💬 פקודות שימושיות (לשלוח בווטסאפ)

| פקודה | מה עושה |
|---|---|
| `/help` | רשימה מלאה |
| `/reset` | איפוס זיכרון שיחה |
| `/cd ~/Projects/myapp` | החלף תיקיית עבודה (אישית לכל משתמש) |
| `/pwd` | איזו תיקייה פעילה |
| `/model opus` | החלף מודל |
| `/session` | מידע סשן |

## 🔒 אבטחה

- **רץ מקומית** — אין שרת ענן, אין שירות חיצוני
- **Whitelist חובה** — רק מספרים מורשים (אלא אם הפעלת "פתוח לכולם")
- **אל תשתף את תיקיית `auth/`** — מכילה session של WhatsApp
- במצב **עוזר אישי** הסוכן יכול להריץ כל פקודה ולמחוק כל קובץ. ודא ש-whitelist מכיל רק אותך.

## 🛠️ פתרון תקלות

**הדפדפן לא נפתח** → http://localhost:7654 ידנית.

**"Port in use"** → יש instance שעוד רץ. סגור את החלון הישן, או:
- Mac: `lsof -ti:7654 | xargs kill`
- Windows: `netstat -ano | findstr :7654` → `taskkill /PID X /F`

**QR לא מופיע** → לחץ 🔄 "סריקה מחדש" בממשק.

**הודעה לא מקבלת תשובה** → בדוק את כרטיס "הודעות שנחסמו" בטאב הראשי — יש כפתור "הוסף" בלחיצה אחת.

**"Claude CLI לא נמצא"** → `npm install -g @anthropic-ai/claude-code`

**bad-request 515 / הסשן שבור** → לחץ 🔄 "סריקה מחדש" — מוחק creds ומייצר QR חדש.

## 📦 דרישות

- **Node.js 18+** — https://nodejs.org
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **macOS 11+ / Windows 10+ / Linux**

## 📂 מבנה התיקייה

```
claude-whatsapp-bot/
├── bot.js              המנוע
├── index.html          ממשק הדפדפן
├── config.json         כל ההגדרות
├── start.command       הפעלה (Mac)
├── start.bat           הפעלה (Windows)
├── auth/               session של WhatsApp 🔒
├── media/              מדיה שהתקבלה
├── feed.json           היסטוריה
└── bot.log             לוג
```

## 🏗️ הטכנולוגיה

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — WhatsApp Web בנודיג'ס (בלי דפדפן)
- **Claude CLI** — מריץ את המודל עם גישה לקבצים
- **OpenAI API** (אופציונלי) — Whisper (תמלול) + TTS (קול)
- **Node HTTP + SSE** — ממשק עם live updates

## 📧 שאלות

נבנה במסגרת סדנת קלוד — שאל את המנחה.