#!/usr/bin/env node
// WhatsApp ↔ Claude Bot — voice, images, memory, quick commands
import baileys, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { spawn, exec } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode-terminal';
import {
  applySetupMode,
  DEFAULT_CONFIG,
  GenerationGate,
  SingleFlight,
  KeyedQueue,
  PendingOutboundGuard,
  RecentIdRegistry,
  messageEnvelope,
  isOwner,
  isSupportedNodeVersion,
  isValidPairingMessage,
  normalizeConfig,
  preferredPhoneJid,
  ReconnectScheduler,
  routeMessage,
  setAllowedGroup,
  sendWithTracking,
  userPart,
  validateConfig,
  writeJsonAtomic,
} from './lib/bot-core.js';
import { persistThenApply, readBody, requestAccessError } from './lib/http-core.js';

const makeWASocket = baileys.default || baileys;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const SESSION_DIR = path.join(__dirname, 'auth');
const HISTORY_PATH = path.join(__dirname, 'feed.json');
const SESSIONS_PATH = path.join(__dirname, 'sessions.json');
const MEDIA_DIR = path.join(__dirname, 'media');
const LOG_FILE = path.join(__dirname, 'bot.log');
const LAUNCH_LOG_FILE = path.join(__dirname, 'launcher.log');
const SENT_IDS_PATH = path.join(__dirname, 'sent-message-ids.json');
const PROCESSED_IDS_PATH = path.join(__dirname, 'processed-message-ids.json');
const PORT = parseInt(process.env.PORT || '7654', 10);
const LOCAL_HOST = '127.0.0.1';
const LOCAL_URL = `http://${LOCAL_HOST}:${PORT}`;
const UI_TOKEN = crypto.randomBytes(24).toString('hex');
const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

function browserIdentity() {
  if (process.platform === 'darwin') return Browsers.macOS('WhatsApp Claude Agent');
  if (process.platform === 'win32') return Browsers.windows('WhatsApp Claude Agent');
  return Browsers.ubuntu('WhatsApp Claude Agent');
}

// ---------- config ----------
function loadConfig() {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch (e) { console.error('❌ config.json:', e.message); process.exit(1); }
}
let config = loadConfig();
const CLAUDE_BIN = config.claudeBin || 'claude';
function saveConfig() {
  writeJsonAtomic(CONFIG_PATH, config);
}
function getWorkdir() {
  return config.workdir || os.homedir();
}
function isChatbotMode() {
  return (config.permissionMode || 'bypassPermissions') === 'plan';
}
function defaultSystemAppend() {
  return `אתה "${config.agentName || 'הסוכן'}" — Claude Code המלא, מחובר לוואטסאפ ורץ על המק של המשתמש.
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
}
function chatbotSystemAppend() {
  const custom = (config.systemPromptAppend || '').trim();
  return `${custom ? `${custom}\n\n` : ''}אתה "${config.agentName || 'הסוכן'}" — בוט WhatsApp במצב צ'אט בוט בטוח.
אין לך גישה לכלי Claude Code או לקבצי המחשב. אל תטען שאתה יכול לקרוא, לערוך, למחוק או להריץ פקודות.
ענה רק על סמך ההודעה והשיחה הנוכחית. אם חסר מידע, בקש מהמשתמש לשלוח אותו בהודעה.

הנחיות תגובה:
- ענה בעברית מדוברת, קצרה וישירה.
- אם מבקשים פעולה על קבצים, קוד, סודות או המחשב, הסבר שאתה במצב צ'אט בוט מוגבל.
- אם זו שאלה של לקוח, ענה בצורה שירותית בלי לחשוף פרטים פנימיים.`;
}
function getSystemAppend() {
  if (isChatbotMode()) return chatbotSystemAppend();
  return config.systemPromptAppend || defaultSystemAppend();
}

// ---------- state ----------
const startedAt = Date.now();
function configState() {
  return {
    agentName: config.agentName,
    workdir: getWorkdir(),
    model: config.model || 'sonnet',
    whitelist: config.whitelist || [],
    ownerNumber: config.ownerNumber || '',
    singleNumberMode: !!config.singleNumberMode,
    allowedChats: config.allowedChats || [],
    allowAllLegacyGroups: !!config.allowAllLegacyGroups,
    onboardingComplete: !!config.onboardingComplete,
    permissionMode: config.permissionMode || 'bypassPermissions',
    publicMode: !!config.publicMode,
    groupPublicMode: !!config.groupPublicMode,
    groupMode: config.groupMode || 'off',
  };
}
let state = {
  status: 'starting',
  qrAscii: null,
  me: null,
  feed: [],
  stats: { messagesIn: 0, messagesOut: 0, blocked: 0, voice: 0, images: 0, ttsReplies: 0 },
  health: { claude: 'checking' },
  lastActivityAt: null,
  features: {
    voice: !!(config.openaiApiKey || process.env.OPENAI_API_KEY),
    images: !isChatbotMode(),
    memory: true,
    tts: !!(config.openaiApiKey || process.env.OPENAI_API_KEY) && (config.ttsMode || 'mirror') !== 'off',
  },
  config: configState(),
  pairing: { active: false },
  blockedList: [],
};
let sseClients = [];
const sentMessageIds = new RecentIdRegistry(SENT_IDS_PATH, { max: 300, ttlMs: 6 * 60 * 60 * 1000 });
const processedMessageIds = new RecentIdRegistry(PROCESSED_IDS_PATH, { max: 1500, ttlMs: 24 * 60 * 60 * 1000 });
const pendingOutbound = new PendingOutboundGuard({ ttlMs: 10_000 });
let messageQueue = new KeyedQueue();
const activeProcesses = new Map();
const runtimeGate = new GenerationGate();
const clearOperation = new SingleFlight();
const memoryResetOperation = new SingleFlight();
const reconnectScheduler = new ReconnectScheduler();
const socketLifecycleGate = new GenerationGate();
let pendingSocketStart = null;

function syncRuntimeConfig({ notify = true } = {}) {
  state.config = configState();
  state.features.voice = !!(config.openaiApiKey || process.env.OPENAI_API_KEY);
  state.features.images = !isChatbotMode();
  state.features.tts = state.features.voice && (config.ttsMode || 'mirror') !== 'off';
  if (notify) broadcast('state', snapshot());
}

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
state.lastActivityAt = state.feed.at(-1)?.t || null;

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
function saveHistory() { try { writeJsonAtomic(HISTORY_PATH, state.feed.slice(-60)); } catch (_) {} }
function saveSessions() { try { writeJsonAtomic(SESSIONS_PATH, { sessions: userSessions, cwd: userCwd }); } catch (_) {} }
function pushFeed(dir, from, text, meta = {}) {
  const activityAt = Date.now();
  state.lastActivityAt = activityAt;
  state.feed.push({ t: activityAt, dir, from, text: text.slice(0, 600), ...meta });
  if (state.feed.length > 60) state.feed.shift();
  saveHistory();
  broadcast('feed', state.feed);
  broadcast('stats', state.stats);
}

let claudeHealthProbe = null;
async function checkClaudeHealth() {
  if (claudeHealthProbe) return claudeHealthProbe;
  const probe = new Promise(resolve => {
    const child = spawn(CLAUDE_BIN, ['--version'], { env: process.env });
    let settled = false;
    const finish = status => {
      if (settled) return;
      settled = true;
      const changed = state.health.claude !== status;
      state.health.claude = status;
      if (changed) broadcast('state', snapshot());
      resolve(status);
    };
    const timer = setTimeout(() => { child.kill(); finish('error'); }, 5000);
    child.once('error', () => { clearTimeout(timer); finish('error'); });
    child.once('exit', code => { clearTimeout(timer); finish(code === 0 ? 'ready' : 'error'); });
  });
  claudeHealthProbe = probe;
  try { return await probe; }
  finally { if (claudeHealthProbe === probe) claudeHealthProbe = null; }
}

function doctorSnapshot() {
  let configOk = true;
  try {
    validateConfig(config);
    const workdir = getWorkdir();
    configOk = fs.existsSync(workdir) && fs.statSync(workdir).isDirectory();
  } catch (_) { configOk = false; }
  let storageOk = true;
  try { fs.accessSync(__dirname, fs.constants.W_OK); } catch (_) { storageOk = false; }
  return {
    checkedAt: Date.now(),
    checks: [
      { id: 'node', label: 'Node.js', ok: isSupportedNodeVersion(process.versions.node), detail: `v${process.versions.node}` },
      { id: 'claude', label: 'Claude Code', ok: state.health.claude === 'ready', detail: state.health.claude },
      { id: 'config', label: 'הגדרות', ok: configOk, detail: configOk ? 'תקין' : 'דורש תיקון' },
      { id: 'whatsapp', label: 'WhatsApp', ok: state.status === 'connected', detail: state.status },
      { id: 'storage', label: 'שמירה מקומית', ok: storageOk, detail: storageOk ? 'ניתן לכתוב' : 'אין הרשאה' },
    ],
  };
}

async function cancelAllActiveWork() {
  runtimeGate.invalidate();
  messageQueue = new KeyedQueue();
  const terminations = [...activeProcesses.keys()].map(conversationId => cancelActive(conversationId)).filter(Boolean);
  await Promise.race([
    Promise.allSettled(terminations),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
}

async function resetAllConversationMemory() {
  await cancelAllActiveWork();
  userSessions = {};
  userCwd = {};
  saveSessions();
  log('🧹 cleared all memory');
}

async function clearLocalData() {
  await stopSocket();
  await cancelAllActiveWork();
  cancelPairing(false);
  const resetConfig = normalizeConfig({ ...DEFAULT_CONFIG });
  writeJsonAtomic(CONFIG_PATH, resetConfig);
  config = resetConfig;

  for (const target of [SESSION_DIR, MEDIA_DIR]) fs.rmSync(target, { recursive: true, force: true });
  for (const target of [HISTORY_PATH, SESSIONS_PATH, LOG_FILE, LAUNCH_LOG_FILE]) fs.rmSync(target, { force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  sentMessageIds.clear();
  processedMessageIds.clear();
  userSessions = {};
  userCwd = {};
  blockedSenders.clear();
  state.feed = [];
  state.lastActivityAt = null;
  state.stats = { messagesIn: 0, messagesOut: 0, blocked: 0, voice: 0, images: 0, ttsReplies: 0 };
  state.blockedList = [];
  state.pairing = { active: false };
  state.me = null;
  state.qrAscii = null;
  syncRuntimeConfig({ notify: false });
  broadcast('feed', []);
  broadcastBlocked();
  reconnectAttempts = 0;
  stopped = false;
  setStatus('starting');
  await startBot();
}

// ---------- whitelist ----------
function addToWhitelist(userPartStr) {
  if (!userPartStr) return false;
  config.whitelist = config.whitelist || [];
  if (!config.whitelist.includes(userPartStr)) {
    config.whitelist.push(userPartStr);
    saveConfig();
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
  saveConfig();
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
function askClaude(prompt, conversationId, generation) {
  return new Promise((resolve, reject) => {
    if (!runtimeGate.isCurrent(generation)) {
      reject(new Error('cancelled'));
      return;
    }
    const resumeId = userSessions[conversationId];
    const args = [
      '-p', prompt,
      '--append-system-prompt', getSystemAppend(),
      '--output-format', 'json',
      '--model', config.model || 'sonnet',
      '--permission-mode', config.permissionMode || 'bypassPermissions',
    ];
    if (isChatbotMode()) args.push('--tools', '');
    if (resumeId) args.push('--resume', resumeId);

    const cwd = isChatbotMode() ? getWorkdir() : (userCwd[conversationId] || getWorkdir());
    const cp = spawn(CLAUDE_BIN, args, { cwd, env: process.env });
    let out = '', err = '';
    let settled = false;
    let wasCancelled = false;
    let forceKillTimer = null;
    let resolveTerminated;
    const terminated = new Promise(resolveTermination => { resolveTerminated = resolveTermination; });
    const finishResolve = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const task = {
      process: cp,
      terminated,
      cancel: () => {
        wasCancelled = true;
        cp.kill('SIGTERM');
        forceKillTimer = setTimeout(() => cp.kill('SIGKILL'), 2000);
        forceKillTimer.unref?.();
        finishReject(new Error('cancelled'));
        return terminated;
      },
    };
    activeProcesses.set(conversationId, task);
    const clearActive = () => {
      if (activeProcesses.get(conversationId) === task) activeProcesses.delete(conversationId);
    };
    const timer = setTimeout(() => {
      cp.kill('SIGTERM');
      forceKillTimer = setTimeout(() => cp.kill('SIGKILL'), 2000);
      forceKillTimer.unref?.();
      clearActive();
      finishReject(new Error('timeout (3m)'));
    }, 180_000);
    cp.stdout.on('data', d => out += d.toString());
    cp.stderr.on('data', d => err += d.toString());
    cp.on('error', e => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      clearActive();
      resolveTerminated();
      finishReject(e);
    });
    cp.on('exit', code => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      clearActive();
      resolveTerminated();
      if (wasCancelled) {
        finishReject(new Error('cancelled'));
        return;
      }
      if (!runtimeGate.isCurrent(generation)) {
        finishReject(new Error('cancelled'));
        return;
      }
      if (code !== 0) { finishReject(new Error((err.slice(-200) || `exit ${code}`).trim())); return; }
      try {
        const json = JSON.parse(out);
        const reply = (json.result || json.response || '').trim() || '(ריק)';
        if (json.session_id && conversationId) {
          userSessions[conversationId] = json.session_id;
          saveSessions();
        }
        finishResolve(reply);
      } catch (e) {
        // fallback: treat as text
        finishResolve(out.trim() || '(ריק)');
      }
    });
  });
}

// ---------- media: images & voice ----------
async function saveMedia(msg, kind, ext, generation) {
  const buf = await downloadMediaMessage(msg, 'buffer', {});
  if (!runtimeGate.isCurrent(generation)) return null;
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
function cancelActive(conversationId) {
  const task = activeProcesses.get(conversationId);
  if (!task) return false;
  task.cancel();
  activeProcesses.delete(conversationId);
  return task.terminated;
}

async function handleCommand(text, conversationId, senderJid) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  if (cmd === '/help' || cmd === '/עזרה') {
    return `🤖 פקודות:\n` +
      `/help — העזרה הזו\n` +
      `/reset — מוחק זיכרון שיחה\n` +
      `/cancel — עוצר משימה פעילה\n` +
      (isChatbotMode() ? '' :
        `/cd <path> — החלף תיקיית עבודה (למשל: /cd ~/Projects/myapp)\n` +
        `/pwd — איזו תיקייה פעילה עכשיו\n` +
        `/session — מידע על הסשן הנוכחי\n`) +
      `/model <sonnet|opus|haiku> — החלף מודל\n\n` +
      `אפשר גם טקסט / תמונה / הודעה קולית — והסוכן יענה.`;
  }
  if (!isOwner(senderJid, config, sock?.user?.id || '')) {
    return '🔒 רק בעל הסוכן יכול להריץ פקודות ניהול.';
  }
  if (cmd === '/reset' || cmd === '/איפוס') {
    delete userSessions[conversationId];
    saveSessions();
    return '✅ הזיכרון נוקה. השיחה הבאה מתחילה חדשה.';
  }
  if (cmd === '/cancel' || cmd === '/עצור') {
    return cancelActive(conversationId) ? '🛑 המשימה נעצרה.' : 'אין כרגע משימה פעילה.';
  }
  if (cmd === '/session') {
    if (isChatbotMode()) return '🔒 הפקודה הזו חסומה במצב צ׳אט בוט.';
    const cwd = userCwd[conversationId] || getWorkdir();
    return (userSessions[conversationId] ? `session: ${userSessions[conversationId]}\n` : '') + `תיקייה: ${cwd}`;
  }
  if (cmd === '/cd') {
    if (isChatbotMode()) return '🔒 במצב צ׳אט בוט אי אפשר להחליף תיקיית עבודה או לגשת לקבצי המחשב.';
    const target = arg.startsWith('~') ? path.join(os.homedir(), arg.slice(1)) : path.resolve(arg);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return `❌ תיקייה לא קיימת: ${target}`;
    }
    userCwd[conversationId] = target;
    delete userSessions[conversationId]; // new context, new memory
    saveSessions();
    return `✅ עברתי ל: ${target}\nהזיכרון נוקה — שיחה חדשה מתחילה.`;
  }
  if (cmd === '/pwd') {
    if (isChatbotMode()) return '🔒 במצב צ׳אט בוט אין תיקיית עבודה חשופה למשתמשים.';
    return userCwd[conversationId] || getWorkdir();
  }
  if (cmd === '/model') {
    if (!['sonnet','opus','haiku'].includes(arg)) return '❌ בחר: sonnet / opus / haiku';
    config.model = arg;
    saveConfig();
    state.config.model = arg;
    broadcast('state', snapshot());
    return `✅ מודל שונה ל-${arg}`;
  }
  return null; // not a command
}

// ---------- WhatsApp ----------
let sock = null, reconnectAttempts = 0, stopped = false;
const groupMetadataCache = new Map();

function ownJids() {
  return [sock?.user?.phoneNumber, sock?.user?.id, sock?.user?.lid].filter(Boolean);
}

function ownPhoneJid() {
  return preferredPhoneJid(ownJids());
}

function cacheGroupMetadata(metadata) {
  if (!metadata?.id) return;
  groupMetadataCache.set(metadata.id, { metadata, expiresAt: Date.now() + GROUP_CACHE_TTL_MS });
}

function cachedGroupMetadata(jid) {
  const entry = groupMetadataCache.get(jid);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    groupMetadataCache.delete(jid);
    return undefined;
  }
  return entry.metadata;
}

async function refreshGroupMetadata(jid) {
  const activeSocket = sock;
  if (!activeSocket || !jid) return;
  try {
    const metadata = await activeSocket.groupMetadata(jid);
    if (sock === activeSocket && !stopped) cacheGroupMetadata(metadata);
  }
  catch (error) { log('group cache:', error.message); }
}

async function sendTracked(jid, content, options) {
  if (!sock) throw new Error('WhatsApp לא מחובר');
  return sendWithTracking({
    send: (target, body, sendOptions) => sock.sendMessage(target, body, sendOptions),
    jid,
    content,
    options,
    sentIds: sentMessageIds,
    pendingGuard: pendingOutbound,
  });
}

function disposeSocket(target) {
  if (!target) return;
  try { target.ev.removeAllListeners(); } catch (_) {}
  try { target.end(undefined); } catch (_) {}
  try { target.ws?.close(); } catch (_) {}
}

async function stopSocket() {
  const generation = socketLifecycleGate.invalidate();
  stopped = true;
  reconnectScheduler.cancel();
  const activeSocket = sock;
  sock = null;
  disposeSocket(activeSocket);
  groupMetadataCache.clear();
  state.qrAscii = null;
  setStatus('stopped');
  log('⏹ נעצר');
  return generation;
}
async function rescan() {
  const generation = await stopSocket();
  if (!socketLifecycleGate.isCurrent(generation)) return;
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (e) { log(e.message); }
  if (!socketLifecycleGate.isCurrent(generation)) return;
  state.me = null; reconnectAttempts = 0; stopped = false;
  setStatus('starting'); log('🔄 סריקה מחדש');
  return startBot().catch(e => log('rescan:', e.message));
}
async function restart() {
  const generation = await stopSocket();
  if (!socketLifecycleGate.isCurrent(generation)) return;
  config = loadConfig();
  syncRuntimeConfig({ notify: false });
  if (!socketLifecycleGate.isCurrent(generation)) return;
  reconnectAttempts = 0; stopped = false;
  setStatus('starting'); log('♻️ restart');
  return startBot().catch(e => log('restart:', e.message));
}

async function startBot() {
  const generation = socketLifecycleGate.capture();
  if (pendingSocketStart?.generation === generation) return pendingSocketStart.promise;
  const entry = { generation, promise: null };
  entry.promise = startBotGeneration(generation).finally(() => {
    if (pendingSocketStart === entry) pendingSocketStart = null;
  });
  pendingSocketStart = entry;
  return entry.promise;
}

async function startBotGeneration(generation) {
  reconnectScheduler.cancel();
  stopped = false;
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  if (!socketLifecycleGate.isCurrent(generation) || stopped) return;

  const activeSocket = makeWASocket({
    auth: authState,
    browser: browserIdentity(),
    cachedGroupMetadata: async jid => cachedGroupMetadata(jid),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
  if (!socketLifecycleGate.isCurrent(generation) || stopped) {
    disposeSocket(activeSocket);
    return;
  }
  const previousSocket = sock;
  sock = activeSocket;
  if (previousSocket && previousSocket !== activeSocket) disposeSocket(previousSocket);

  activeSocket.ev.on('creds.update', update => { if (sock === activeSocket) saveCreds(update); });
  activeSocket.ev.on('groups.upsert', groups => { if (sock === activeSocket) groups.forEach(cacheGroupMetadata); });
  activeSocket.ev.on('groups.update', groups => { if (sock === activeSocket) groups.forEach(group => refreshGroupMetadata(group.id)); });
  activeSocket.ev.on('group-participants.update', event => { if (sock === activeSocket) refreshGroupMetadata(event.id); });

  activeSocket.ev.on('connection.update', (u) => {
    if (sock !== activeSocket) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      qrcode.generate(qr, { small: true }, (ascii) => {
        if (sock !== activeSocket) return;
        state.qrAscii = ascii; setStatus('qr'); broadcast('qr', { ascii });
      });
    }
    if (connection === 'open') {
      reconnectScheduler.cancel();
      state.me = ownPhoneJid() || activeSocket.user?.id || null; state.qrAscii = null; reconnectAttempts = 0;
      setStatus('connected'); log('🟢 מחובר', state.me ? `(${state.me})` : '');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log('🔴 נפל:', code);
      if (code === DisconnectReason.loggedOut) {
        socketLifecycleGate.invalidate();
        stopped = true;
        reconnectScheduler.cancel();
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) {}
        setStatus('stopped'); return;
      }
      if (stopped) return;
      reconnectAttempts++;
      if (reconnectAttempts > 5) { setStatus('error'); return; }
      reconnectScheduler.schedule(
        () => { if (!stopped && sock === activeSocket) startBot().catch(e => log(e.message)); },
        Math.min(30000, 3000 * reconnectAttempts),
      );
    }
  });

  async function processAuthorizedMessage(msg, envelope, generation) {
    if (!runtimeGate.isCurrent(generation)) return;
    if (pendingOutbound.matches(msg) || (envelope.id && sentMessageIds.has(envelope.id))) return;
    const { replyJid, senderJid, conversationKey } = envelope;
    const m = msg.message || {};
    let prompt = null, meta = { chat: replyJid, isGroup: envelope.isGroup };

    const text = m.conversation || m.extendedTextMessage?.text;
    if (text) prompt = text;

    const audio = m.audioMessage;
    if (audio) {
      try {
        const audioPath = await saveMedia(msg, 'audio', 'ogg', generation);
        if (!audioPath || !runtimeGate.isCurrent(generation)) return;
        log('🎤 voice received →', path.basename(audioPath));
        state.stats.voice++;
        try {
          const transcript = await transcribeVoice(audioPath);
          if (!runtimeGate.isCurrent(generation)) { fs.rmSync(audioPath, { force: true }); return; }
          prompt = `[תמליל קולי]: ${transcript}`;
          meta = { ...meta, kind: 'voice', transcript };
        } catch (e) {
          if (!runtimeGate.isCurrent(generation)) return;
          if (e.message === 'no_api_key') {
            await sendTracked(replyJid, { text: '🎤 קיבלתי הודעה קולית אבל אין מפתח OpenAI מוגדר. אפשר להוסיף אותו בהגדרות הקול.' });
            return;
          }
          throw e;
        }
      } catch (e) {
        if (!runtimeGate.isCurrent(generation)) return;
        log('voice err:', e.message);
        try { await sendTracked(replyJid, { text: `סליחה, שגיאה בקול: ${e.message}` }); } catch (_) {}
        return;
      }
    }

    const image = m.imageMessage;
    if (image) {
      if (isChatbotMode()) {
        const caption = image.caption ? `קיבלתי תמונה עם הכיתוב: ${image.caption}` : 'קיבלתי תמונה.';
        prompt = `${caption}\n\n[הערה: במצב צ׳אט בוט בטוח אין לי גישה לפתיחת קבצים או תמונות. בקש מהמשתמש לתאר את התמונה אם צריך.]`;
        meta = { ...meta, kind: 'image' };
      } else {
        try {
          const imgPath = await saveMedia(msg, 'image', 'jpg', generation);
          if (!imgPath || !runtimeGate.isCurrent(generation)) return;
          log('📸 image received →', path.basename(imgPath));
          state.stats.images++;
          const caption = image.caption || 'נתח את התמונה הזו בבקשה';
          prompt = `${caption}\n\n[תמונה מצורפת: ${imgPath}] - קרא אותה עם Read tool ונתח לפי השאלה.`;
          meta = { ...meta, kind: 'image', path: imgPath };
        } catch (e) {
          if (!runtimeGate.isCurrent(generation)) return;
          log('img err:', e.message);
          try { await sendTracked(replyJid, { text: `שגיאה בתמונה: ${e.message}` }); } catch (_) {}
          return;
        }
      }
    }

    if (!runtimeGate.isCurrent(generation) || !prompt || !prompt.trim()) return;

    if (prompt.startsWith('/')) {
      const cmdReply = await handleCommand(prompt, conversationKey, senderJid);
      if (cmdReply !== null) {
        if (!runtimeGate.isCurrent(generation)) return;
        try { await sendTracked(replyJid, { text: cmdReply }); } catch (_) {}
        pushFeed('in', userPart(senderJid), prompt, meta);
        pushFeed('out', userPart(senderJid), cmdReply, { ...meta, kind: 'command' });
        state.stats.messagesIn++; state.stats.messagesOut++;
        return;
      }
    }

    state.stats.messagesIn++;
    log('⬅️', userPart(senderJid), '|', (meta.kind || 'text'), '|', prompt.slice(0, 60));
    pushFeed('in', userPart(senderJid), prompt, meta);
    try { await sock.sendPresenceUpdate('composing', replyJid); } catch (_) {}
    if (!runtimeGate.isCurrent(generation)) return;

    let progressTimer = setTimeout(() => {
      if (!runtimeGate.isCurrent(generation)) return;
      sendTracked(replyJid, { text: '⏳ קיבלתי, אני עדיין עובד על זה...' }).catch(() => {});
      progressTimer = null;
    }, 10_000);

    try {
      const reply = await askClaude(prompt, conversationKey, generation);
      if (progressTimer) clearTimeout(progressTimer);
      if (!runtimeGate.isCurrent(generation)) return;
      await sendTracked(replyJid, { text: reply });
      if (!runtimeGate.isCurrent(generation)) return;
      state.stats.messagesOut++;
      log('➡️', userPart(senderJid), '|', reply.slice(0, 60).replace(/\n/g, ' '));
      pushFeed('out', userPart(senderJid), reply, meta);

      const ttsMode = config.ttsMode || 'mirror';
      const hasKey = !!(config.openaiApiKey || process.env.OPENAI_API_KEY);
      const shouldTTS = hasKey && (ttsMode === 'always' || (ttsMode === 'mirror' && meta.kind === 'voice'));
      if (shouldTTS) {
        try {
          const generatedAudio = await synthesizeVoice(reply);
          if (!runtimeGate.isCurrent(generation)) return;
          await sendTracked(replyJid, { audio: generatedAudio, ptt: true, mimetype: 'audio/ogg; codecs=opus' });
          state.stats.ttsReplies++;
          log('🔊 tts reply sent');
          broadcast('stats', state.stats);
        } catch (e) {
          log('tts err:', e.message);
        }
      }
    } catch (e) {
      if (progressTimer) clearTimeout(progressTimer);
      if (e.message === 'cancelled' || !runtimeGate.isCurrent(generation)) {
        log('🛑 task cancelled:', conversationKey);
      } else {
        log('❌', e.message);
        try { await sendTracked(replyJid, { text: `סליחה, תקלה: ${e.message.slice(0, 150)}` }); } catch (_) {}
      }
    } finally {
      if (runtimeGate.isCurrent(generation)) {
        try { await sock.sendPresenceUpdate('paused', replyJid); } catch (_) {}
      }
    }
  }

  activeSocket.ev.on('messages.upsert', async (ev) => {
    if (sock !== activeSocket || clearOperation.running || memoryResetOperation.running) return;
    if (ev.type !== 'notify') return;
    for (const msg of ev.messages) {
      const envelope = messageEnvelope(msg, ownJids());
      if (!envelope.remoteJid || envelope.remoteJid.endsWith('@broadcast')) continue;
      if (pendingOutbound.matches(msg)) continue;
      if (envelope.id && (sentMessageIds.has(envelope.id) || processedMessageIds.has(envelope.id))) continue;
      if (envelope.id) processedMessageIds.add(envelope.id);

      if (pairing && Date.now() < pairing.expiresAt && isValidPairingMessage(envelope, pairing.code, ownJids())) {
        const up = envelope.senderNumber;
        const nextConfig = normalizeConfig({
          ...config,
          ownerNumber: up,
          whitelist: [...new Set([...(config.whitelist || []), up])],
          singleNumberMode: false,
          onboardingComplete: true,
        });
        persistThenApply(nextConfig, {
          persist: value => writeJsonAtomic(CONFIG_PATH, value),
          apply: value => { config = value; syncRuntimeConfig(); },
        });
        blockedSenders.delete(up);
        broadcastBlocked();
        log('🔗 paired:', up);
        cancelPairing(true, up);
        try { await sendTracked(envelope.replyJid, { text: `✅ חיבור הצליח! המספר שלך (${up}) נוסף. שלח "/help" לרשימת פקודות.` }); } catch (_) {}
        continue;
      }

      const routed = routeMessage({
        msg,
        config,
        ownJid: ownJids(),
        sentIds: sentMessageIds,
        processedIds: new Set(),
      });
      if (routed.action === 'ignore') continue;
      if (routed.action === 'block') {
        state.stats.blocked++;
        const up = routed.envelope.senderNumber;
        const prev = blockedSenders.get(up) || { count: 0 };
        blockedSenders.set(up, {
          count: prev.count + 1,
          lastSeen: Date.now(),
          jid: routed.envelope.senderJid,
          isGroup: routed.envelope.isGroup,
          preview: routed.envelope.text.slice(0, 80) || '[מדיה]',
        });
        broadcastBlocked();
        log('⛔ חסום:', routed.envelope.senderJid, '(blocked list updated)');
        broadcast('stats', state.stats);
        continue;
      }

      if (routed.envelope.text.startsWith('/cancel') || routed.envelope.text.startsWith('/עצור')) {
        const reply = await handleCommand(routed.envelope.text, routed.envelope.conversationKey, routed.envelope.senderJid);
        try { await sendTracked(routed.envelope.replyJid, { text: reply }); } catch (_) {}
        continue;
      }

      const generation = runtimeGate.capture();
      messageQueue.enqueue(
        routed.envelope.conversationKey,
        () => processAuthorizedMessage(msg, routed.envelope, generation),
      ).catch(e => log('queue err:', e.message));
    }
  });
}

// ---------- HTTP server ----------
const INDEX_PATH = path.join(__dirname, 'index.html');
function readIndex() {
  try { return fs.readFileSync(INDEX_PATH, 'utf8').replaceAll('__UI_TOKEN__', UI_TOKEN); }
  catch (_) { return '<h1>index.html missing</h1>'; }
}

http.createServer(async (req, res) => {
  try {
    const accessError = requestAccessError(req, { expectedToken: UI_TOKEN, port: PORT });
    if (accessError) {
      res.writeHead(accessError.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: accessError.code }));
    }
    if ((clearOperation.running || memoryResetOperation.running) && req.method === 'POST') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end('{"error":"reset_in_progress"}');
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readIndex());
    }
    if (req.url === '/state') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify(snapshot())); }
    if (req.url === '/doctor' && req.method === 'GET') {
      await checkClaudeHealth();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(doctorSnapshot()));
    }
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
        const next = validateConfig(JSON.parse(body));
        if (next.openaiApiKey === '***') next.openaiApiKey = config.openaiApiKey;
        if (next.workdir && (!fs.existsSync(next.workdir) || !fs.statSync(next.workdir).isDirectory())) {
          throw new Error('תיקיית העבודה אינה קיימת');
        }
        writeJsonAtomic(CONFIG_PATH, next);
        res.writeHead(200); res.end('{"ok":true}');
        log('💾 config saved → restart');
        restart();
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (req.url === '/test' && req.method === 'POST') {
      if (!sock || state.status !== 'connected') { res.writeHead(400); return res.end('{"error":"not connected"}'); }
      const to = config.ownerNumber || (config.whitelist || [])[0];
      if (!to) { res.writeHead(400); return res.end('{"error":"no whitelist"}'); }
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      try {
        await sendTracked(jid, { text: `🧪 בדיקה: הסוכן "${config.agentName}" מחובר ופועל. אם ההודעה הגיעה, החיבור תקין.` });
        res.writeHead(200); return res.end('{"ok":true}');
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({error:e.message})); }
    }

    if (req.url === '/reset-all-sessions' && req.method === 'POST') {
      await memoryResetOperation.run(resetAllConversationMemory);
      res.writeHead(200); return res.end('{"ok":true}');
    }

    if (req.url === '/local-data/clear' && req.method === 'POST') {
      await clearOperation.run(clearLocalData);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, status: state.status }));
    }

    if (req.url === '/setup' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        if (!sock || state.status !== 'connected') throw new Error('WhatsApp עדיין לא מחובר');
        const { mode, chatJid = '' } = JSON.parse(body);
        const nextConfig = applySetupMode(config, { mode, chatJid, ownJid: ownPhoneJid() });
        persistThenApply(nextConfig, {
          persist: value => writeJsonAtomic(CONFIG_PATH, value),
          apply: value => { config = value; syncRuntimeConfig(); },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, needsPairing: !config.onboardingComplete }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
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
        Object.values(all).forEach(cacheGroupMetadata);
        const list = Object.values(all).map(g => ({
          jid: g.id,
          name: g.subject,
          size: g.size,
          enabled: (config.allowedChats || []).includes(g.id),
          legacyEnabled: !!config.allowAllLegacyGroups,
        }));
        res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify(list));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.url === '/group/allow' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { jid, enabled } = JSON.parse(body);
        const nextConfig = setAllowedGroup(config, { jid, enabled });
        persistThenApply(nextConfig, {
          persist: value => writeJsonAtomic(CONFIG_PATH, value),
          apply: value => { config = value; syncRuntimeConfig(); },
        });
        res.writeHead(200); return res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
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
        await sendTracked(jid, { text });
        res.writeHead(200); return res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
    }

    res.writeHead(404); res.end();
  } catch (e) {
    log('http err:', e.message);
    try { res.writeHead(e.statusCode || 500); res.end(e.message); } catch (_) {}
  }
}).listen(PORT, LOCAL_HOST, () => {
  log(`🌐 ${LOCAL_URL}`);
  const url = LOCAL_URL;
  const cmd = process.platform === 'darwin' ? `open "${url}"`
            : process.platform === 'win32' ? `start "" "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, { shell: true });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', e => log('uncaught:', e.message));

checkClaudeHealth().catch(error => log('claude health:', error.message));
startBot().catch(e => { log('fatal:', e.message); setStatus('error'); });
