import fs from 'fs';
import path from 'path';

export const DEFAULT_CONFIG = Object.freeze({
  agentName: 'הסוכן שלי',
  workdir: '',
  model: 'sonnet',
  whitelist: [],
  ownerNumber: '',
  singleNumberMode: false,
  allowedChats: [],
  allowAllLegacyGroups: false,
  onboardingComplete: false,
  publicMode: false,
  groupPublicMode: false,
  groupMode: 'off',
  permissionMode: 'bypassPermissions',
  systemPromptAppend: '',
  openaiApiKey: '',
  ttsMode: 'mirror',
  ttsVoice: 'alloy',
});

const MODELS = new Set(['sonnet', 'opus', 'haiku']);
const GROUP_MODES = new Set(['off', 'mention', 'always']);
const PERMISSION_MODES = new Set(['plan', 'manual', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']);
const TTS_MODES = new Set(['off', 'mirror', 'always']);
const TTS_VOICES = new Set(['alloy', 'nova', 'shimmer', 'onyx', 'echo', 'fable']);

// Windows: node's spawn cannot run npm's claude.cmd shim, so resolve a real
// executable (claude.exe from the native installer) or the npm cli.js via node.
export function resolveClaudeInvocation({
  claudeBin = '',
  platform = process.platform,
  env = process.env,
  nodeBin = process.execPath,
  exists = filePath => fs.existsSync(filePath),
} = {}) {
  if (claudeBin) return { bin: claudeBin, prefixArgs: [] };
  if (platform !== 'win32') return { bin: 'claude', prefixArgs: [] };
  const win = path.win32;
  const home = env.USERPROFILE || '';
  const pathDirs = String(env.PATH || env.Path || '').split(';').map(dir => dir.trim()).filter(Boolean);
  const candidates = [...new Set([...(home ? [win.join(home, '.local', 'bin')] : []), ...pathDirs])];
  for (const dir of candidates) {
    const exe = win.join(dir, 'claude.exe');
    if (exists(exe)) return { bin: exe, prefixArgs: [] };
  }
  for (const dir of candidates) {
    if (!exists(win.join(dir, 'claude.cmd'))) continue;
    const cli = win.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (exists(cli)) return { bin: nodeBin, prefixArgs: [cli] };
  }
  return { bin: 'claude', prefixArgs: [] };
}

export function isSupportedNodeVersion(version = '') {
  const [major = 0, minor = 0] = String(version).split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 9);
}

export function userPart(jid = '') {
  return String(jid).split('@')[0].split(':')[0];
}

function jidList(value) {
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

export function preferredPhoneJid(value = '') {
  const jids = jidList(value);
  return jids.find(jid => jid.endsWith('@s.whatsapp.net')) || jids[0] || '';
}

function matchesAnyUser(jid, candidates = []) {
  const user = userPart(jid);
  return Boolean(user && jidList(candidates).some(candidate => userPart(candidate) === user));
}

export function normalizePhone(value = '') {
  return String(value).replace(/^\+/, '').replace(/\D/g, '');
}

function uniqueStrings(values, transform = value => String(value)) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(transform).filter(Boolean))];
}

export function normalizeConfig(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const permissionMode = raw.permissionMode === 'default' ? 'manual' : raw.permissionMode;
  const whitelist = uniqueStrings(raw.whitelist, normalizePhone);
  const hasExplicitAllowedChats = Object.prototype.hasOwnProperty.call(raw, 'allowedChats');
  const hasExplicitOnboarding = Object.prototype.hasOwnProperty.call(raw, 'onboardingComplete');
  const ownerNumber = normalizePhone(raw.ownerNumber) || whitelist[0] || '';
  return {
    ...raw,
    agentName: String(raw.agentName ?? DEFAULT_CONFIG.agentName).trim() || DEFAULT_CONFIG.agentName,
    workdir: String(raw.workdir ?? DEFAULT_CONFIG.workdir).trim(),
    model: MODELS.has(raw.model) ? raw.model : DEFAULT_CONFIG.model,
    whitelist,
    ownerNumber,
    singleNumberMode: raw.singleNumberMode === true,
    allowedChats: uniqueStrings(raw.allowedChats),
    allowAllLegacyGroups: raw.allowAllLegacyGroups === true
      || (!hasExplicitAllowedChats && GROUP_MODES.has(raw.groupMode) && raw.groupMode !== 'off'),
    onboardingComplete: raw.onboardingComplete === true || (!hasExplicitOnboarding && Boolean(ownerNumber)),
    publicMode: raw.publicMode === true,
    groupPublicMode: raw.groupPublicMode === true,
    groupMode: GROUP_MODES.has(raw.groupMode) ? raw.groupMode : DEFAULT_CONFIG.groupMode,
    permissionMode: PERMISSION_MODES.has(permissionMode) ? permissionMode : DEFAULT_CONFIG.permissionMode,
    systemPromptAppend: String(raw.systemPromptAppend ?? ''),
    openaiApiKey: String(raw.openaiApiKey ?? ''),
    ttsMode: TTS_MODES.has(raw.ttsMode) ? raw.ttsMode : DEFAULT_CONFIG.ttsMode,
    ttsVoice: TTS_VOICES.has(raw.ttsVoice) ? raw.ttsVoice : DEFAULT_CONFIG.ttsVoice,
  };
}

export function applySetupMode(input, { mode, chatJid = '', ownJid = '' } = {}) {
  if (!['one-number', 'separate-number', 'group-bot'].includes(mode)) {
    throw new Error('מצב התקנה לא חוקי');
  }
  if (chatJid && !String(chatJid).endsWith('@g.us')) throw new Error('קבוצה לא חוקית');

  const next = normalizeConfig(input);
  const ownNumber = normalizePhone(userPart(ownJid));
  if (!ownNumber) throw new Error('מספר WhatsApp המחובר אינו זמין');

  next.allowAllLegacyGroups = false;
  next.publicMode = false;
  next.groupPublicMode = false;

  if (mode === 'one-number') {
    next.ownerNumber = ownNumber;
    next.whitelist = [...new Set([ownNumber, ...next.whitelist])];
    next.singleNumberMode = true;
    next.allowedChats = chatJid ? [chatJid] : [];
    next.groupMode = chatJid ? 'always' : 'off';
    next.permissionMode = 'bypassPermissions';
    next.onboardingComplete = true;
    return next;
  }

  if (next.ownerNumber === ownNumber) {
    next.ownerNumber = '';
    next.whitelist = next.whitelist.filter(number => number !== ownNumber);
  }
  next.singleNumberMode = false;
  next.allowedChats = mode === 'group-bot' ? [chatJid] : [];
  next.groupMode = mode === 'group-bot' ? 'mention' : 'off';
  next.permissionMode = mode === 'group-bot' ? 'plan' : 'bypassPermissions';
  next.groupPublicMode = mode === 'group-bot';
  next.onboardingComplete = Boolean(next.ownerNumber);

  if (mode === 'group-bot' && !chatJid) throw new Error('בחר קבוצה');
  return next;
}

export function setAllowedGroup(input, { jid, enabled } = {}) {
  if (!String(jid || '').endsWith('@g.us')) throw new Error('קבוצה לא חוקית');
  if (typeof enabled !== 'boolean') throw new Error('enabled חייב להיות true או false');
  const next = normalizeConfig(input);
  const chats = new Set(next.allowedChats);
  if (enabled) chats.add(jid); else chats.delete(jid);
  next.allowedChats = [...chats];
  next.allowAllLegacyGroups = false;
  if (enabled && next.groupMode === 'off') next.groupMode = next.singleNumberMode ? 'always' : 'mention';
  return next;
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('הגדרות חייבות להיות אובייקט JSON');
  }
  if ('model' in input && !MODELS.has(input.model)) throw new Error('מודל Claude אינו חוקי');
  if ('groupMode' in input && !GROUP_MODES.has(input.groupMode)) throw new Error('מצב הקבוצות אינו חוקי');
  if ('permissionMode' in input && input.permissionMode !== 'default' && !PERMISSION_MODES.has(input.permissionMode)) {
    throw new Error('מצב ההרשאות אינו חוקי');
  }
  if ('ttsMode' in input && !TTS_MODES.has(input.ttsMode)) throw new Error('מצב התשובה הקולית אינו חוקי');
  if ('ttsVoice' in input && !TTS_VOICES.has(input.ttsVoice)) throw new Error('קול הדובר אינו חוקי');
  if ('whitelist' in input && !Array.isArray(input.whitelist)) throw new Error('רשימת המספרים אינה חוקית');
  if ('allowedChats' in input && !Array.isArray(input.allowedChats)) throw new Error('רשימת הצ׳אטים אינה חוקית');
  for (const key of ['singleNumberMode', 'onboardingComplete', 'publicMode', 'groupPublicMode', 'allowAllLegacyGroups']) {
    if (key in input && typeof input[key] !== 'boolean') throw new Error(`${key} חייב להיות true או false`);
  }
  return normalizeConfig(input);
}

export function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function extractMessageText(message = {}) {
  return String(
    message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || ''
  ).trim();
}

export function messageEnvelope(msg, ownJid = '') {
  const remoteJid = msg?.key?.remoteJid || '';
  const remoteIdentityJid = preferredPhoneJid([msg?.key?.remoteJidAlt, remoteJid]);
  const isGroup = remoteJid.endsWith('@g.us');
  const fromMe = msg?.key?.fromMe === true;
  const participantJid = preferredPhoneJid([msg?.key?.participantAlt, msg?.key?.participant]);
  const senderJid = fromMe
    ? (preferredPhoneJid(ownJid) || participantJid || remoteIdentityJid)
    : (isGroup ? (participantJid || remoteJid) : remoteIdentityJid);
  return {
    id: msg?.key?.id || '',
    remoteJid,
    remoteIdentityJid,
    replyJid: remoteJid,
    senderJid,
    senderNumber: userPart(senderJid),
    isGroup,
    fromMe,
    text: extractMessageText(msg?.message || {}),
    conversationKey: remoteJid ? `chat:${remoteJid}` : '',
  };
}

export function isValidPairingMessage(envelope, code, ownJid = '') {
  if (!envelope || !code) return false;
  if (envelope.isGroup || envelope.fromMe) return false;
  if (envelope.text.trim() !== String(code)) return false;
  return Boolean(envelope.senderNumber
    && !jidList(ownJid).some(jid => userPart(jid) === envelope.senderNumber));
}

export function isOwner(senderJid, config, ownJid = '') {
  const sender = userPart(senderJid);
  const owner = normalizePhone(config?.ownerNumber);
  return owner ? sender === owner : matchesAnyUser(senderJid, ownJid);
}

export function isMentioned(message, ownJid = '') {
  const mentioned = message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  return mentioned.some(jid => matchesAnyUser(jid, ownJid));
}

export function routeMessage({ msg, config, ownJid = '', sentIds = new Set(), processedIds = new Set() }) {
  const envelope = messageEnvelope(msg, ownJid);
  if (!envelope.remoteJid || envelope.remoteJid.endsWith('@broadcast')) {
    return { action: 'ignore', reason: 'unsupported-chat', envelope };
  }
  if (envelope.id && sentIds.has(envelope.id)) {
    return { action: 'ignore', reason: 'bot-generated', envelope };
  }
  if (envelope.id && processedIds.has(envelope.id)) {
    return { action: 'ignore', reason: 'duplicate', envelope };
  }

  const normalized = normalizeConfig(config);
  if (!normalized.onboardingComplete) {
    return { action: 'ignore', reason: 'onboarding-incomplete', envelope };
  }
  const owner = isOwner(envelope.senderJid, normalized, ownJid);
  const chatAllowed = normalized.allowedChats.includes(envelope.remoteJid)
    || (envelope.isGroup && normalized.allowAllLegacyGroups);
  const selfChat = !envelope.isGroup
    && userPart(envelope.remoteIdentityJid)
    && (normalized.ownerNumber
      ? userPart(envelope.remoteIdentityJid) === normalized.ownerNumber
      : matchesAnyUser(envelope.remoteIdentityJid, ownJid));

  if (envelope.fromMe) {
    if (!normalized.singleNumberMode) {
      return { action: 'ignore', reason: 'from-me-disabled', envelope };
    }
    if (!owner || (!selfChat && !chatAllowed)) {
      return { action: 'ignore', reason: 'from-me-chat-not-allowed', envelope };
    }
  }

  if (envelope.isGroup) {
    if (!chatAllowed) return { action: 'ignore', reason: 'group-not-allowed', envelope };
    if (normalized.groupMode === 'off') return { action: 'ignore', reason: 'groups-off', envelope };
    if (normalized.groupMode === 'mention' && !owner && !isMentioned(msg?.message, ownJid)) {
      return { action: 'ignore', reason: 'mention-required', envelope };
    }
  }

  const senderAllowed = normalized.publicMode
    || (envelope.isGroup && normalized.groupPublicMode)
    || owner
    || normalized.whitelist.includes(envelope.senderNumber);
  if (!senderAllowed) return { action: 'block', reason: 'sender-not-allowed', envelope };

  return { action: 'process', reason: 'allowed', envelope };
}

function outboundKind(content = {}) {
  if (typeof content.text === 'string') return `text:${content.text}`;
  if (content.audio) return 'audio';
  if (content.image) return 'image';
  if (content.document) return 'document';
  if (content.react) return `reaction:${content.react.key?.id || ''}:${content.react.text || ''}`;
  return 'other';
}

function incomingKind(msg) {
  const message = msg?.message || {};
  const text = extractMessageText(message);
  if (text) return `text:${text}`;
  if (message.audioMessage) return 'audio';
  if (message.imageMessage) return 'image';
  if (message.documentMessage) return 'document';
  if (message.reactionMessage) {
    return `reaction:${message.reactionMessage.key?.id || ''}:${message.reactionMessage.text || ''}`;
  }
  return 'other';
}

export class PendingOutboundGuard {
  constructor({ ttlMs = 30_000 } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.nextToken = 1;
  }

  begin(jid, content) {
    this.prune();
    const token = String(this.nextToken++);
    this.entries.set(token, { jid, kind: outboundKind(content), at: Date.now() });
    return token;
  }

  cancel(token) {
    this.entries.delete(token);
  }

  matches(msg) {
    this.prune();
    if (msg?.key?.fromMe !== true) return false;
    const jid = msg?.key?.remoteJid || '';
    const kind = incomingKind(msg);
    for (const entry of this.entries.values()) {
      if (entry.jid === jid && entry.kind === kind) return true;
    }
    return false;
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [token, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(token);
    }
  }
}

export async function sendWithTracking({ send, jid, content, options, sentIds, pendingGuard }) {
  const token = pendingGuard.begin(jid, content);
  try {
    const sent = await send(jid, content, options);
    if (sent?.key?.id) sentIds.add(sent.key.id);
    pendingGuard.cancel(token);
    return sent;
  } catch (error) {
    pendingGuard.cancel(token);
    throw error;
  }
}

export class RecentIdRegistry {
  constructor(filePath, { max = 1000, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.filePath = filePath;
    this.max = max;
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.load();
  }

  load() {
    try {
      const values = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(values)) {
        for (const entry of values) {
          if (entry?.id) this.entries.set(String(entry.id), Number(entry.at) || Date.now());
        }
      }
      this.prune(false);
    } catch (_) {}
  }

  has(id) {
    if (!id) return false;
    const at = this.entries.get(String(id));
    if (!at) return false;
    if (Date.now() - at > this.ttlMs) {
      this.entries.delete(String(id));
      return false;
    }
    return true;
  }

  add(id) {
    if (!id) return;
    this.entries.set(String(id), Date.now());
    this.prune(false);
    this.save();
  }

  prune(save = true) {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, at] of this.entries) {
      if (at < cutoff) this.entries.delete(id);
    }
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value);
    }
    if (save) this.save();
  }

  save() {
    try {
      writeJsonAtomic(this.filePath, [...this.entries].map(([id, at]) => ({ id, at })));
    } catch (_) {}
  }

  clear() {
    this.entries.clear();
    try { fs.rmSync(this.filePath, { force: true }); } catch (_) {}
  }
}

export class KeyedQueue {
  constructor() {
    this.tails = new Map();
  }

  enqueue(key, task) {
    const previous = this.tails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.tails.set(key, current);
    current.finally(() => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    }).catch(() => {});
    return current;
  }
}

export class GenerationGate {
  constructor() { this.generation = 0; }
  capture() { return this.generation; }
  isCurrent(value) { return value === this.generation; }
  invalidate() { return ++this.generation; }
}

export class ReconnectScheduler {
  constructor({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.generation = 0;
  }

  schedule(callback, delayMs) {
    this.cancel();
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      if (generation !== this.generation) return;
      this.timer = null;
      callback();
    }, delayMs);
  }

  cancel() {
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}

export class SingleFlight {
  constructor() { this.current = null; }
  get running() { return this.current !== null; }
  run(task) {
    if (this.current) return this.current;
    const current = Promise.resolve().then(task);
    this.current = current.finally(() => {
      if (this.current === wrapped) this.current = null;
    });
    const wrapped = this.current;
    return wrapped;
  }
}
