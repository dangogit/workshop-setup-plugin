#!/usr/bin/env node
// WhatsApp ↔ Claude Bot — voice, images, memory, quick commands
import baileys, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { spawn, exec } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode-terminal';

const makeWASocket = baileys.default || baileys;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const SESSION_DIR = path.join(__dirname, 'auth');
const HISTORY_PATH = path.join(__dirname, 'feed.json');
const SESSIONS_PATH = path.join(__dirname, 'sessions.json');
const MEDIA_DIR = path.join(__dirname, 'media');
const LOG_FILE = path.join(__dirname, 'bot.log');
const PORT = parseInt(process.env.PORT || '7654', 10);

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- config ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { console.error('❌ config.json:', e.message); process.exit(1); }
}
let config = loadConfig();
const CLAUDE_BIN = config.claudeBin || 'claude';
const DEFAULT_SYSTEM_APPEND = `אתה "${config.agentName || 'הסוכן'}" — Claude Code המלא, מחובר לוואטסאפ ורץ על המק של המשתמש.
יש לך גישה מלאה לכל הכלים שלך: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch וכל השאר.
אתה יכול:
- לקרוא ולערוך קבצים בכל מקום על המק (לא רק ב-workdir הנוכחי).
- להריץ פקודות bash, לבנות קוד, להתקין חבילות.
- לחקור פרויקטים (אם המשתמש מציין נתיב כמו ~/Projects/X).
- לחפש באינטרנט ולמשוך דפים.

הנחיות תגובה:
- ענה בעברית מדוברת, חמה, ישירה.
- תשובות קצרות (זה וואטסאפ — לא דו"ח). אם ביצעת פעולה, תאר אותה בקצרה.
- בלי "שאלה מעולה", בלי באזוורדס.
- אם זו הודעה ראשונה ("שלום"/"היי") — הצג את עצמך בשורה:
  "היי! אני ${config.agentName || 'הסוכן'} 👋 יש לי גישה מלאה למק — תגיד מה לעשות."
- תמונות שמצורפות — קרא אותן מהמיקום שצויין בטקסט.
- אם קיבלת תמליל של הודעה קולית ("[תמליל קולי]: ...") — התייחס אליה כמו הודעת טקסט רגילה.
- משימות ארוכות (בנייה, ריפקטורינג) — בצע עד הסוף, אחר-כך דווח מה עשית.`;
const SYSTEM_APPEND = config.systemPromptAppend || DEFAULT_SYSTEM_APPEND;
const WORKDIR = config.workdir || os.homedir();

// ---------- state ----------
const startedAt = Date.now();
let state = {
  status: 'starting',
  qrAscii: null,
  me: null,
  feed: [],
  stats: { messagesIn: 0, messagesOut: 0, blocked: 0, voice: 0, images: 0, ttsReplies: 0 },
  features: {
    voice: !!(config.openaiApiKey || process.env.OPENAI_API_KEY),
    images: true,
    memory: true,
    tts: !!(config.openaiApiKey || process.env.OPENAI_API_KEY) && (config.ttsMode || 'mirror') !== 'off',
  },
  config: {
    agentName: config.agentName,
    workdir: WORKDIR,
    model: config.model || 'sonnet',
    whitelist: config.whitelist || [],
    permissionMode: config.permissionMode || 'bypassPermissions',
    publicMode: !!config.publicMode,
    groupMode: config.groupMode || 'off',
  },
  pairing: { active: false },
  blockedList: [],
};
let sseClients = [];

// per-user Claude sessions + cwd override
let userSessions = {};
let userCwd = {};  // jid → absolute path
try {
  const s = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
  userSessions = s.sessions || s;
  userCwd = s.cwd || {};
} catch (_) {}

// pairing state (one active at a time)
let pairing = null; // { code, expiresAt, timer }

// blocked senders — shown in UI so user can one-click whitelist
let blockedSenders = new Map(); // userPart → { count, lastSeen, jid, preview }

// recent history
try { state.feed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')).slice(-60); } catch (_) {}

function log(...args) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  broadcast('log', { line });
}
function setStatus(s) { state.status = s; broadcast('state', snapshot()); }
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch (_) {} });
}
function snapshot() { return { ...state, uptime: Date.now() - startedAt }; }
function saveHistory() { try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(state.feed.slice(-60))); } catch (_) {} }
function saveSessions() { try { fs.writeFileSync(SESSIONS_PATH, JSON.stringify({ sessions: userSessions, cwd: userCwd })); } catch (_) {} }
function pushFeed(dir, from, text, meta = {}) {
  state.feed.push({ t: Date.now(), dir, from, text: text.slice(0, 600), ...meta });
  if (state.feed.length > 60) state.feed.shift();
  saveHistory();
  broadcast('feed', state.feed);
  broadcast('stats', state.stats);
}

// ---------- whitelist ----------
const userPart = (jid) => jid.split('@')[0].split(':')[0];
function isAllowed(jid) {
  if (config.publicMode) return true;
  return (config.whitelist || []).includes(userPart(jid));
}

function addToWhitelist(userPartStr) {
  if (!userPartStr) return false;
  config.whitelist = config.whitelist || [];
  if (!config.whitelist.includes(userPartStr)) {
    config.whitelist.push(userPartStr);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    state.config.whitelist = config.whitelist;
    broadcast('state', snapshot());
  }
  // also remove from blocked list
  blockedSenders.delete(userPartStr);
  broadcastBlocked();
  return true;
}
function removeFromWhitelist(userPartStr) {
  config.whitelist = (config.whitelist || []).filter(x => x !== userPartStr);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  state.config.whitelist = config.whitelist;
  broadcast('state', snapshot());
}
function broadcastBlocked() {
  const arr = [...blockedSenders.entries()].map(([up, v]) => ({ userPart: up, ...v }));
  state.blockedList = arr;
  broadcast('blocked', arr);
}

// ---------- pairing ----------
function startPairing() {
  if (pairing?.timer) clearTimeout(pairing.timer);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pairing = {
    code,
    expiresAt: Date.now() + 180_000, // 3 minutes
    timer: setTimeout(() => { if (pairing) cancelPairing(false); }, 180_000),
  };
  state.pairing = { active: true, code, expiresAt: pairing.expiresAt };
  broadcast('pairing', state.pairing);
  log(`🔗 pairing code: ${code} (3min)`);
  return code;
}
function cancelPairing(success = false, userAdded = null) {
  if (pairing?.timer) clearTimeout(pairing.timer);
  pairing = null;
  state.pairing = { active: false, success, userAdded };
  broadcast('pairing', state.pairing);
}

// ---------- claude invocation ----------
function askClaude(prompt, userJid) {
  return new Promise((resolve, reject) => {
    const resumeId = userSessions[userJid];
    const args = [
      '-p', prompt,
      '--append-system-prompt', SYSTEM_APPEND,
      '--output-format', 'json',
      '--model', config.model || 'sonnet',
      '--permission-mode', config.permissionMode || 'bypassPermissions',
    ];
    if (resumeId) args.push('--resume', resumeId);

    const cwd = userCwd[userJid] || WORKDIR;
    const cp = spawn(CLAUDE_BIN, args, { cwd, env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => { cp.kill('SIGTERM'); reject(new Error('timeout (3m)')); }, 180_000);
    cp.stdout.on('data', d => out += d.toString());
    cp.stderr.on('data', d => err += d.toString());
    cp.on('error', e => { clearTimeout(timer); reject(e); });
    cp.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error((err.slice(-200) || `exit ${code}`).trim())); return; }
      try {
        const json = JSON.parse(out);
        const reply = (json.result || json.response || '').trim() || '(ריק)';
        if (json.session_id && userJid) {
          userSessions[userJid] = json.session_id;
          saveSessions();
        }
        resolve(reply);
      } catch (e) {
        // fallback: treat as text
        resolve(out.trim() || '(ריק)');
      }
    });
  });
}

// ---------- media: images & voice ----------
async function saveMedia(msg, kind, ext) {
  const buf = await downloadMediaMessage(msg, 'buffer', {});
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const full = path.join(MEDIA_DIR, name);
  fs.writeFileSync(full, buf);
  return full;
}

async function transcribeVoice(audioPath) {
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('no_api_key');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)]), 'audio.ogg');
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.text;
}

async function synthesizeVoice(text) {
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('no_api_key');
  // cap at 1000 chars to control cost/latency
  const input = text.length > 1000 ? text.slice(0, 1000) + '...' : text;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ttsModel || 'tts-1',
      input,
      voice: config.ttsVoice || 'alloy',
      response_format: 'opus',
    }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}: ${await res.text()}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// ---------- slash commands ----------
async function handleCommand(text, from) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  if (cmd === '/help' || cmd === '/עזרה') {
    return `🤖 פקודות:\n` +
      `/help — העזרה הזו\n` +
      `/reset — מוחק זיכרון שיחה\n` +
      `/cd <path> — החלף תיקיית עבודה (למשל: /cd ~/Projects/myapp)\n` +
      `/pwd — איזו תיקייה פעילה עכשיו\n` +
      `/session — מידע על הסשן הנוכחי\n` +
      `/model <sonnet|opus|haiku> — החלף מודל\n\n` +
      `אפשר גם טקסט / תמונה / הודעה קולית — והסוכן יענה.`;
  }
  if (cmd === '/reset' || cmd === '/איפוס') {
    delete userSessions[from];
    saveSessions();
    return '✅ הזיכרון נוקה. השיחה הבאה מתחילה חדשה.';
  }
  if (cmd === '/session') {
    const cwd = userCwd[from] || WORKDIR;
    return (userSessions[from] ? `session: ${userSessions[from]}\n` : '') + `תיקייה: ${cwd}`;
  }
  if (cmd === '/cd') {
    const target = arg.startsWith('~') ? path.join(os.homedir(), arg.slice(1)) : path.resolve(arg);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return `❌ תיקייה לא קיימת: ${target}`;
    }
    userCwd[from] = target;
    delete userSessions[from]; // new context, new memory
    saveSessions();
    return `✅ עברתי ל: ${target}\nהזיכרון נוקה — שיחה חדשה מתחילה.`;
  }
  if (cmd === '/pwd') {
    return userCwd[from] || WORKDIR;
  }
  if (cmd === '/model') {
    if (!['sonnet','opus','haiku'].includes(arg)) return '❌ בחר: sonnet / opus / haiku';
    config.model = arg;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return `✅ מודל שונה ל-${arg}`;
  }
  return null; // not a command
}

// ---------- WhatsApp ----------
let sock = null, reconnectAttempts = 0, stopped = false;

async function stopSocket() {
  stopped = true;
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.end(undefined); } catch (_) {}
    try { sock.ws?.close(); } catch (_) {}
    sock = null;
  }
  state.qrAscii = null;
  setStatus('stopped');
  log('⏹ נעצר');
}
async function rescan() {
  await stopSocket();
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (e) { log(e.message); }
  state.me = null; reconnectAttempts = 0; stopped = false;
  setStatus('starting'); log('🔄 סריקה מחדש');
  startBot().catch(e => log('rescan:', e.message));
}
async function restart() {
  await stopSocket();
  config = loadConfig();
  state.config = {
    agentName: config.agentName,
    workdir: config.workdir || WORKDIR,
    model: config.model || 'sonnet',
    whitelist: config.whitelist || [],
    permissionMode: config.permissionMode || 'bypassPermissions',
    publicMode: !!config.publicMode,
    groupMode: config.groupMode || 'off',
  };
  state.features.voice = !!(config.openaiApiKey || process.env.OPENAI_API_KEY);
  state.features.tts = state.features.voice && (config.ttsMode || 'mirror') !== 'off';
  reconnectAttempts = 0; stopped = false;
  setStatus('starting'); log('♻️ restart');
  startBot().catch(e => log('restart:', e.message));
}

async function startBot() {
  stopped = false;
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    auth: authState, version,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      qrcode.generate(qr, { small: true }, (ascii) => {
        state.qrAscii = ascii; setStatus('qr'); broadcast('qr', { ascii });
      });
    }
    if (connection === 'open') {
      state.me = sock.user?.id || null; state.qrAscii = null; reconnectAttempts = 0;
      setStatus('connected'); log('🟢 מחובר', state.me ? `(${state.me})` : '');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log('🔴 נפל:', code);
      if (code === DisconnectReason.loggedOut) {
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) {}
        setStatus('stopped'); return;
      }
      if (stopped) return;
      reconnectAttempts++;
      if (reconnectAttempts > 5) { setStatus('error'); return; }
      setTimeout(() => { if (!stopped) startBot().catch(e => log(e.message)); }, Math.min(30000, 3000 * reconnectAttempts));
    }
  });

  sock.ev.on('messages.upsert', async (ev) => {
    if (ev.type !== 'notify') return;
    for (const msg of ev.messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (!from || from.endsWith('@broadcast')) continue;

      const isGroup = from.endsWith('@g.us');
      // actual sender in groups is participant; in DM it's remoteJid
      const senderJid = isGroup ? (msg.key.participant || from) : from;
      const replyJid = from; // always reply to remoteJid (group or DM)

      // ---- pairing check (pre-whitelist) ----
      const msgText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
      if (pairing && Date.now() < pairing.expiresAt && msgText.includes(pairing.code)) {
        const up = userPart(senderJid);
        addToWhitelist(up);
        log('🔗 paired:', up);
        cancelPairing(true, up);
        try { await sock.sendMessage(replyJid, { text: `✅ חיבור הצליח! המספר שלך (${up}) נוסף ל-whitelist. שלח "/help" לרשימת פקודות.` }); } catch (_) {}
        continue;
      }

      // ---- group mode filtering ----
      if (isGroup) {
        const gm = config.groupMode || 'off';
        if (gm === 'off') continue;
        if (gm === 'mention') {
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const myId = sock.user?.id?.split(':')[0];
          const isMentioned = mentioned.some(j => (j || '').split(':')[0].split('@')[0] === myId);
          if (!isMentioned) continue;
        }
        // 'always' mode falls through
      }

      // ---- whitelist check ----
      if (!isAllowed(senderJid)) {
        state.stats.blocked++;
        const up = userPart(senderJid);
        const prev = blockedSenders.get(up) || { count: 0 };
        blockedSenders.set(up, {
          count: prev.count + 1,
          lastSeen: Date.now(),
          jid: senderJid,
          isGroup,
          preview: msgText.slice(0, 80) || '[מדיה]',
        });
        broadcastBlocked();
        log('⛔ חסום:', senderJid, '(blocked list updated)');
        broadcast('stats', state.stats);
        continue;
      }

      // determine message type
      const m = msg.message || {};
      let prompt = null, meta = {};

      // 1. text
      const text = m.conversation || m.extendedTextMessage?.text;
      if (text) prompt = text;

      // 2. voice / audio
      const audio = m.audioMessage;
      if (audio) {
        try {
          const audioPath = await saveMedia(msg, 'audio', 'ogg');
          log('🎤 voice received →', path.basename(audioPath));
          state.stats.voice++;
          try {
            const transcript = await transcribeVoice(audioPath);
            prompt = `[תמליל קולי]: ${transcript}`;
            meta = { kind: 'voice', transcript };
          } catch (e) {
            if (e.message === 'no_api_key') {
              try { await sock.sendMessage(from, { text: '🎤 קיבלתי הודעה קולית אבל אין API key של OpenAI מוגדר. הוסף `openaiApiKey` ב-config.json או OPENAI_API_KEY ב-env.' }); } catch (_) {}
              continue;
            }
            throw e;
          }
        } catch (e) {
          log('voice err:', e.message);
          try { await sock.sendMessage(from, { text: `סליחה, שגיאה בקול: ${e.message}` }); } catch (_) {}
          continue;
        }
      }

      // 3. image
      const image = m.imageMessage;
      if (image) {
        try {
          const imgPath = await saveMedia(msg, 'image', 'jpg');
          log('📸 image received →', path.basename(imgPath));
          state.stats.images++;
          const caption = image.caption || 'נתח את התמונה הזו בבקשה';
          prompt = `${caption}\n\n[תמונה מצורפת: ${imgPath}] — קרא אותה עם Read tool ונתח לפי השאלה.`;
          meta = { kind: 'image', path: imgPath };
        } catch (e) {
          log('img err:', e.message);
          try { await sock.sendMessage(from, { text: `שגיאה בתמונה: ${e.message}` }); } catch (_) {}
          continue;
        }
      }

      if (!prompt || !prompt.trim()) continue;

      // slash command?
      if (prompt.startsWith('/')) {
        const cmdReply = await handleCommand(prompt, senderJid);
        if (cmdReply !== null) {
          try { await sock.sendMessage(from, { text: cmdReply }); } catch (_) {}
          pushFeed('in', userPart(senderJid), prompt);
          pushFeed('out', userPart(senderJid), cmdReply, { kind: 'command' });
          state.stats.messagesIn++; state.stats.messagesOut++;
          continue;
        }
      }

      state.stats.messagesIn++;
      log('⬅️', userPart(senderJid), '|', (meta.kind || 'text'), '|', prompt.slice(0, 60));
      pushFeed('in', userPart(senderJid), prompt, meta);

      try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}

      try {
        const reply = await askClaude(prompt, senderJid);
        await sock.sendMessage(from, { text: reply });
        state.stats.messagesOut++;
        log('➡️', userPart(senderJid), '|', reply.slice(0, 60).replace(/\n/g, ' '));
        pushFeed('out', userPart(senderJid), reply);

        // TTS reply (mirror = reply with audio when input was audio; always = every reply)
        const ttsMode = config.ttsMode || 'mirror';
        const hasKey = !!(config.openaiApiKey || process.env.OPENAI_API_KEY);
        const shouldTTS = hasKey && (ttsMode === 'always' || (ttsMode === 'mirror' && meta.kind === 'voice'));
        if (shouldTTS) {
          try {
            const audio = await synthesizeVoice(reply);
            await sock.sendMessage(from, { audio, ptt: true, mimetype: 'audio/ogg; codecs=opus' });
            state.stats.ttsReplies++;
            log('🔊 tts reply sent');
            broadcast('stats', state.stats);
          } catch (e) {
            log('tts err:', e.message);
          }
        }
      } catch (e) {
        log('❌', e.message);
        try { await sock.sendMessage(from, { text: `סליחה, תקלה: ${e.message.slice(0, 150)}` }); } catch (_) {}
      } finally {
        try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}
      }
    }
  });
}

// ---------- HTTP server ----------
const INDEX_PATH = path.join(__dirname, 'index.html');
function readIndex() {
  try { return fs.readFileSync(INDEX_PATH, 'utf8'); }
  catch (_) { return '<h1>index.html missing</h1>'; }
}

function readBody(req) { return new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); }); }

http.createServer(async (req, res) => {
  try {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readIndex());
    }
    if (req.url === '/state') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify(snapshot())); }
    if (req.url === '/stream') {
      res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      if (state.qrAscii) res.write(`event: qr\ndata: ${JSON.stringify({ ascii: state.qrAscii })}\n\n`);
      if (state.feed.length) res.write(`event: feed\ndata: ${JSON.stringify(state.feed)}\n\n`);
      sseClients.push(res);
      req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
      return;
    }
    if (req.url === '/stop' && req.method === 'POST') { await stopSocket(); res.writeHead(200); return res.end('{"ok":true}'); }
    if (req.url === '/start' && req.method === 'POST') {
      if (!sock) { stopped=false; reconnectAttempts=0; setStatus('starting'); startBot().catch(e=>log(e.message)); }
      res.writeHead(200); return res.end('{"ok":true}');
    }
    if (req.url === '/rescan' && req.method === 'POST') { rescan().catch(e=>log(e.message)); res.writeHead(200); return res.end('{"ok":true}'); }
    if (req.url === '/restart' && req.method === 'POST') { restart().catch(e=>log(e.message)); res.writeHead(200); return res.end('{"ok":true}'); }
    if (req.url === '/kill' && req.method === 'POST') { res.writeHead(200); res.end('bye'); setTimeout(()=>process.exit(0),100); return; }

    if (req.url === '/config' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type':'application/json'});
      const safe = { ...config };
      if (safe.openaiApiKey) safe.openaiApiKey = '***';
      return res.end(JSON.stringify(safe, null, 2));
    }
    if (req.url === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const next = JSON.parse(body);
        if (next.openaiApiKey === '***') next.openaiApiKey = config.openaiApiKey;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
        res.writeHead(200); res.end('{"ok":true}');
        log('💾 config saved → restart');
        restart();
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (req.url === '/test' && req.method === 'POST') {
      if (!sock || state.status !== 'connected') { res.writeHead(400); return res.end('{"error":"not connected"}'); }
      const to = (config.whitelist || [])[0];
      if (!to) { res.writeHead(400); return res.end('{"error":"no whitelist"}'); }
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, { text: `🧪 בדיקה: הסוכן "${config.agentName}" שולח לך הודעה מהמק של דניאל. אם אתה רואה את זה — הכל עובד!` });
        res.writeHead(200); return res.end('{"ok":true}');
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({error:e.message})); }
    }

    if (req.url === '/reset-all-sessions' && req.method === 'POST') {
      userSessions = {}; saveSessions(); log('🧹 cleared all memory');
      res.writeHead(200); return res.end('{"ok":true}');
    }

    // ---- pairing ----
    if (req.url === '/pair/start' && req.method === 'POST') {
      const code = startPairing();
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ code, expiresAt: pairing.expiresAt }));
    }
    if (req.url === '/pair/cancel' && req.method === 'POST') {
      cancelPairing(false);
      res.writeHead(200); return res.end('{"ok":true}');
    }

    // ---- whitelist CRUD ----
    if (req.url === '/whitelist/add' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { userPart: up } = JSON.parse(body);
        if (!up) throw new Error('missing userPart');
        addToWhitelist(String(up).replace(/^\+/,'').replace(/\D/g,''));
        res.writeHead(200); return res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.url === '/whitelist/remove' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { userPart: up } = JSON.parse(body);
        removeFromWhitelist(up);
        res.writeHead(200); return res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
    }

    // ---- groups ----
    if (req.url === '/groups' && req.method === 'GET') {
      try {
        if (!sock) { res.writeHead(200); return res.end('[]'); }
        const all = await sock.groupFetchAllParticipating();
        const list = Object.values(all).map(g => ({ jid: g.id, name: g.subject, size: g.size }));
        res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify(list));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.url === '/group/join' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { invite } = JSON.parse(body);
        if (!sock) throw new Error('לא מחובר');
        const match = String(invite||'').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
        const code = match ? match[1] : String(invite||'').trim();
        if (!code) throw new Error('missing invite');
        const groupJid = await sock.groupAcceptInvite(code);
        log('👥 joined:', groupJid);
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ jid: groupJid }));
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.url === '/group/leave' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { jid } = JSON.parse(body);
        if (!sock) throw new Error('לא מחובר');
        await sock.groupLeave(jid);
        res.writeHead(200); return res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.url === '/group/send' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { jid, text } = JSON.parse(body);
        if (!sock) throw new Error('לא מחובר');
        await sock.sendMessage(jid, { text });
        res.writeHead(200); return res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
    }

    res.writeHead(404); res.end();
  } catch (e) {
    log('http err:', e.message);
    try { res.writeHead(500); res.end(e.message); } catch (_) {}
  }
}).listen(PORT, () => {
  log(`🌐 http://localhost:${PORT}`);
  const url = `http://localhost:${PORT}`;
  const cmd = process.platform === 'darwin' ? `open "${url}"`
            : process.platform === 'win32' ? `start "" "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, { shell: true });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', e => log('uncaught:', e.message));

startBot().catch(e => { log('fatal:', e.message); setStatus('error'); });