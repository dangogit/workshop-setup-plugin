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

export function userPart(jid = '') {
  return String(jid).split('@')[0].split(':')[0];
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
  return {
    ...raw,
    agentName: String(raw.agentName ?? DEFAULT_CONFIG.agentName).trim() || DEFAULT_CONFIG.agentName,
    workdir: String(raw.workdir ?? DEFAULT_CONFIG.workdir).trim(),
    model: MODELS.has(raw.model) ? raw.model : DEFAULT_CONFIG.model,
    whitelist,
    ownerNumber: normalizePhone(raw.ownerNumber) || whitelist[0] || '',
    singleNumberMode: raw.singleNumberMode === true,
    allowedChats: uniqueStrings(raw.allowedChats),
    allowAllLegacyGroups: raw.allowAllLegacyGroups === true
      || (!hasExplicitAllowedChats && GROUP_MODES.has(raw.groupMode) && raw.groupMode !== 'off'),
    onboardingComplete: raw.onboardingComplete === true,
    publicMode: raw.publicMode === true,
    groupMode: GROUP_MODES.has(raw.groupMode) ? raw.groupMode : DEFAULT_CONFIG.groupMode,
    permissionMode: PERMISSION_MODES.has(permissionMode) ? permissionMode : DEFAULT_CONFIG.permissionMode,
    systemPromptAppend: String(raw.systemPromptAppend ?? ''),
    openaiApiKey: String(raw.openaiApiKey ?? ''),
    ttsMode: TTS_MODES.has(raw.ttsMode) ? raw.ttsMode : DEFAULT_CONFIG.ttsMode,
    ttsVoice: TTS_VOICES.has(raw.ttsVoice) ? raw.ttsVoice : DEFAULT_CONFIG.ttsVoice,
  };
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
  for (const key of ['singleNumberMode', 'onboardingComplete', 'publicMode', 'allowAllLegacyGroups']) {
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
  const isGroup = remoteJid.endsWith('@g.us');
  const fromMe = msg?.key?.fromMe === true;
  const senderJid = fromMe
    ? (ownJid || msg?.key?.participant || remoteJid)
    : (isGroup ? (msg?.key?.participant || remoteJid) : remoteJid);
  return {
    id: msg?.key?.id || '',
    remoteJid,
    replyJid: remoteJid,
    senderJid,
    senderNumber: userPart(senderJid),
    isGroup,
    fromMe,
    text: extractMessageText(msg?.message || {}),
    conversationKey: remoteJid ? `chat:${remoteJid}` : '',
  };
}

export function isOwner(senderJid, config, ownJid = '') {
  const sender = userPart(senderJid);
  const owner = normalizePhone(config?.ownerNumber) || userPart(ownJid);
  return Boolean(sender && owner && sender === owner);
}

export function isMentioned(message, ownJid = '') {
  const own = userPart(ownJid);
  const mentioned = message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  return Boolean(own && mentioned.some(jid => userPart(jid) === own));
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
  const owner = isOwner(envelope.senderJid, normalized, ownJid);
  const chatAllowed = normalized.allowedChats.includes(envelope.remoteJid)
    || (envelope.isGroup && normalized.allowAllLegacyGroups);
  const selfChat = !envelope.isGroup
    && userPart(envelope.remoteJid)
    && userPart(envelope.remoteJid) === (normalized.ownerNumber || userPart(ownJid));

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
