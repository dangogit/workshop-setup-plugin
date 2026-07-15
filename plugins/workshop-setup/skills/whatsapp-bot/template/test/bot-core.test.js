import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  KeyedQueue,
  PendingOutboundGuard,
  RecentIdRegistry,
  normalizeConfig,
  routeMessage,
  sendWithTracking,
  validateConfig,
  writeJsonAtomic,
} from '../lib/bot-core.js';

const OWN = '972500000000:12@s.whatsapp.net';
const OWNER = '972500000000';
const GROUP = '120363000000@g.us';

function message({ id = 'm1', fromMe = false, remoteJid = `${OWNER}@s.whatsapp.net`, participant, text = 'hello', mentionedJid = [] } = {}) {
  return {
    key: { id, fromMe, remoteJid, participant },
    message: mentionedJid.length
      ? { extendedTextMessage: { text, contextInfo: { mentionedJid } } }
      : { conversation: text },
  };
}

function config(overrides = {}) {
  return normalizeConfig({
    ownerNumber: OWNER,
    whitelist: [OWNER],
    singleNumberMode: true,
    allowedChats: [GROUP],
    groupMode: 'always',
    ...overrides,
  });
}

test('one-number self-chat messages are processed', () => {
  const result = routeMessage({ msg: message({ fromMe: true }), config: config(), ownJid: OWN });
  assert.equal(result.action, 'process');
  assert.equal(result.envelope.conversationKey, `chat:${OWNER}@s.whatsapp.net`);
});

test('one-number owner messages in an enabled private group are processed', () => {
  const result = routeMessage({
    msg: message({ fromMe: true, remoteJid: GROUP, participant: OWN }),
    config: config(),
    ownJid: OWN,
  });
  assert.equal(result.action, 'process');
  assert.equal(result.envelope.conversationKey, `chat:${GROUP}`);
});

test('separate bot-number mode still processes whitelisted direct messages', () => {
  const sender = '972511111111@s.whatsapp.net';
  const result = routeMessage({
    msg: message({ remoteJid: sender }),
    config: config({ ownerNumber: '972511111111', whitelist: ['972511111111'], singleNumberMode: false }),
    ownJid: OWN,
  });
  assert.equal(result.action, 'process');
});

test('fromMe messages stay disabled outside one-number mode', () => {
  const result = routeMessage({
    msg: message({ fromMe: true }),
    config: config({ singleNumberMode: false }),
    ownJid: OWN,
  });
  assert.equal(result.reason, 'from-me-disabled');
});

test('bot-generated fromMe echoes are ignored without creating a loop', () => {
  const result = routeMessage({
    msg: message({ id: 'bot-reply', fromMe: true, remoteJid: GROUP, participant: OWN }),
    config: config(),
    ownJid: OWN,
    sentIds: new Set(['bot-reply']),
  });
  assert.equal(result.action, 'ignore');
  assert.equal(result.reason, 'bot-generated');
});

test('owner messages in groups not explicitly enabled are ignored', () => {
  const result = routeMessage({
    msg: message({ fromMe: true, remoteJid: 'other@g.us', participant: OWN }),
    config: config(),
    ownJid: OWN,
  });
  assert.equal(result.action, 'ignore');
  assert.equal(result.reason, 'from-me-chat-not-allowed');
});

test('legacy group configs remain active until explicit group selection is saved', () => {
  const participant = '972511111111@s.whatsapp.net';
  const legacy = normalizeConfig({
    ownerNumber: OWNER,
    whitelist: [OWNER, '972511111111'],
    groupMode: 'mention',
  });
  assert.equal(legacy.allowAllLegacyGroups, true);
  const result = routeMessage({
    msg: message({ remoteJid: GROUP, participant, mentionedJid: [OWN] }),
    config: legacy,
    ownJid: OWN,
  });
  assert.equal(result.action, 'process');

  const explicit = normalizeConfig({ ...legacy, allowedChats: [], allowAllLegacyGroups: false });
  const blocked = routeMessage({
    msg: message({ remoteJid: GROUP, participant, mentionedJid: [OWN] }),
    config: explicit,
    ownJid: OWN,
  });
  assert.equal(blocked.reason, 'group-not-allowed');
});

test('non-whitelisted participant is blocked in an enabled owner-only group', () => {
  const result = routeMessage({
    msg: message({ remoteJid: GROUP, participant: '972511111111@s.whatsapp.net' }),
    config: config(),
    ownJid: OWN,
  });
  assert.equal(result.action, 'block');
});

test('mention mode requires a mention for non-owner participants', () => {
  const participant = '972511111111@s.whatsapp.net';
  const cfg = config({ whitelist: [OWNER, '972511111111'], groupMode: 'mention' });
  const ignored = routeMessage({ msg: message({ remoteJid: GROUP, participant }), config: cfg, ownJid: OWN });
  assert.equal(ignored.reason, 'mention-required');

  const allowed = routeMessage({
    msg: message({ remoteJid: GROUP, participant, mentionedJid: [OWN] }),
    config: cfg,
    ownJid: OWN,
  });
  assert.equal(allowed.action, 'process');
});

test('duplicate message IDs are ignored', () => {
  const result = routeMessage({
    msg: message({ id: 'duplicate' }),
    config: config(),
    ownJid: OWN,
    processedIds: new Set(['duplicate']),
  });
  assert.equal(result.reason, 'duplicate');
});

test('conversation keys isolate the same sender across groups', () => {
  const participant = '972511111111@s.whatsapp.net';
  const first = routeMessage({
    msg: message({ remoteJid: GROUP, participant, mentionedJid: [OWN] }),
    config: config({ whitelist: [OWNER, '972511111111'], groupMode: 'mention' }),
    ownJid: OWN,
  });
  const secondGroup = '120363999999@g.us';
  const second = routeMessage({
    msg: message({ id: 'm2', remoteJid: secondGroup, participant, mentionedJid: [OWN] }),
    config: config({ whitelist: [OWNER, '972511111111'], groupMode: 'mention', allowedChats: [GROUP, secondGroup] }),
    ownJid: OWN,
  });
  assert.notEqual(first.envelope.conversationKey, second.envelope.conversationKey);
});

test('legacy default permission mode is normalized to current manual mode', () => {
  assert.equal(normalizeConfig({ permissionMode: 'default' }).permissionMode, 'manual');
});

test('legacy installs promote the first whitelisted number to owner', () => {
  assert.equal(normalizeConfig({ whitelist: ['+972-50-123-4567'] }).ownerNumber, '972501234567');
});

test('invalid modes are rejected instead of silently replacing the existing config', () => {
  assert.throws(() => validateConfig({ groupMode: 'typo' }), /מצב הקבוצות/);
  assert.throws(() => validateConfig({ permissionMode: 'root' }), /מצב ההרשאות/);
  assert.throws(() => validateConfig({ model: 'imaginary' }), /מודל Claude/);
  assert.throws(() => validateConfig({ ttsMode: 'sometimes' }), /מצב התשובה הקולית/);
  assert.throws(() => validateConfig({ ttsVoice: 'robot' }), /קול הדובר/);
});

test('atomic JSON writes leave valid complete JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bot-core-'));
  const file = path.join(directory, 'state.json');
  writeJsonAtomic(file, { ok: true, value: 42 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true, value: 42 });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('recent ID registry persists and enforces its maximum size', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bot-ids-'));
  const file = path.join(directory, 'ids.json');
  const registry = new RecentIdRegistry(file, { max: 2 });
  registry.add('one');
  registry.add('two');
  registry.add('three');
  const reloaded = new RecentIdRegistry(file, { max: 2 });
  assert.equal(reloaded.has('one'), false);
  assert.equal(reloaded.has('two'), true);
  assert.equal(reloaded.has('three'), true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('pending outbound guard blocks an echo emitted before send resolves', async () => {
  const guard = new PendingOutboundGuard();
  const ids = new Set();
  const echo = message({ id: 'early-echo', fromMe: true, remoteJid: GROUP, participant: OWN, text: 'answer' });
  let guardedDuringSend = false;

  await sendWithTracking({
    jid: GROUP,
    content: { text: 'answer' },
    sentIds: { add: id => ids.add(id) },
    pendingGuard: guard,
    send: async () => {
      guardedDuringSend = guard.matches(echo);
      await Promise.resolve();
      return { key: { id: 'early-echo' } };
    },
  });

  assert.equal(guardedDuringSend, true);
  assert.equal(ids.has('early-echo'), true);
  assert.equal(guard.matches(echo), false);
});

test('keyed queue preserves order within a chat and allows parallel chats', async () => {
  const queue = new KeyedQueue();
  const events = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });

  const first = queue.enqueue('chat-a', async () => {
    events.push('a1-start');
    await gate;
    events.push('a1-end');
  });
  const second = queue.enqueue('chat-a', async () => events.push('a2'));
  const other = queue.enqueue('chat-b', async () => events.push('b1'));

  await other;
  assert.deepEqual(events, ['a1-start', 'b1']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['a1-start', 'b1', 'a1-end', 'a2']);
});
