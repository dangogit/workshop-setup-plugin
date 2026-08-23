import fs from 'fs';
import path from 'path';
import { DEFAULT_CONFIG, writeJsonAtomic } from './bot-core.js';

export const BASE_PORT = 7654;

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Files/dirs a pre-multi-account install keeps at <install>/ that move into
// <install>/accounts/<id>/ when adopted. Kept in one place so bot.js's own
// path list (see BASE_DIR-relative constants near the top of bot.js) and this
// list stay obviously in sync if either changes.
//
// config.json is deliberately NOT in this list: it is the legacy sentinel
// (see hasLegacyInstall/adoptLegacyInstall below) and must be the LAST thing
// moved, so it is handled on its own after LEGACY_DIRS and LEGACY_FILES.
const LEGACY_FILES = [
  'feed.json',
  'sessions.json',
  'bot.log',
  'sent-message-ids.json',
  'processed-message-ids.json',
];
const LEGACY_DIRS = ['auth', 'media'];
const LEGACY_SENTINEL_FILE = 'config.json';

export function accountsDir(installDir) {
  return path.join(installDir, 'accounts');
}

export function accountDir(installDir, id) {
  return path.join(accountsDir(installDir), id);
}

// Kept for backwards compatibility only. A port is no longer derived from an
// account's sort position - see allocatePort() and the hubPort field below.
export function portForIndex(index) {
  return BASE_PORT + 1 + index;
}

function existingAccountIds(installDir) {
  try {
    return fs.readdirSync(accountsDir(installDir), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(isValidAccountId);
  } catch (_) {
    return [];
  }
}

// Ports are stable and persisted per account (config.json's hubPort field)
// instead of being recomputed from sort position - adding or removing a
// sibling account must never shift an already-running account's port out
// from under it. Returns the lowest integer >= BASE_PORT + 1 that is not
// already claimed by hubPort on any existing account and is not in exclude
// (callers pass their own listening port there so it can never be handed to
// a child).
export function allocatePort(installDir, { exclude = [] } = {}) {
  const used = new Set(exclude);
  for (const id of existingAccountIds(installDir)) {
    const port = readAccountConfig(installDir, id)?.hubPort;
    if (Number.isInteger(port) && port > 0) used.add(port);
  }
  let port = BASE_PORT + 1;
  while (used.has(port)) port += 1;
  return port;
}

export function isValidAccountId(id) {
  if (typeof id !== 'string' || !id) return false;
  if (id.includes('..') || id.includes('/')) return false;
  return ACCOUNT_ID_PATTERN.test(id);
}

// Hebrew-safe: strips to ascii letters/digits and hyphenates. A name with no
// latin/digit characters at all (e.g. a pure-Hebrew agent name) has nothing
// left to slugify, so we fall back to a generated account-N id instead of
// producing an empty or invalid one.
//
// installDir is optional so this stays callable without disk context, but
// pass it whenever one is available: without it the fallback can only use
// a time-based id and two pure-Hebrew-named accounts created within the same
// ~100 second window collide (the create throws the "already exists" error
// below, which reads as a bug rather than a naming clash). With installDir
// the fallback probes account-1, account-2, ... against what already exists
// on disk and is always collision-free.
export function slugifyAccountId(name, installDir) {
  const ascii = String(name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  if (ascii && isValidAccountId(ascii)) return ascii;
  return firstFreeGeneratedId(installDir);
}

function firstFreeGeneratedId(installDir) {
  if (!installDir) return `account-${Date.now() % 100000}`;
  let n = 1;
  while (fs.existsSync(accountDir(installDir, `account-${n}`))) n += 1;
  return `account-${n}`;
}

export function readAccountConfig(installDir, id) {
  const configPath = path.join(accountDir(installDir, id), 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

export function accountRole(config) {
  if (!config) return 'unconfigured';
  if (config.groupPublicMode === true) return 'group-bot';
  if (config.singleNumberMode === true) return 'one-number';
  if (config.ownerNumber) return 'separate-number';
  return 'unconfigured';
}

function describeListening(config, role) {
  if (!config || role === 'unconfigured') return 'לא מוגדר';
  const allowedChats = Array.isArray(config.allowedChats) ? config.allowedChats : [];
  if (role === 'group-bot') return 'קבוצה';
  if (role === 'one-number') return allowedChats.length > 0 ? 'קבוצה פרטית' : 'צ׳אט עצמי';
  return 'פרטי';
}

// index is kept as a positional argument for backwards compatibility but is
// no longer used to derive the port - see resolveHubPort() below.
export function accountSummary(installDir, id, index, { exclude = [] } = {}) {
  const config = readAccountConfig(installDir, id);
  const role = accountRole(config);
  return {
    id,
    name: config?.agentName || id,
    dir: accountDir(installDir, id),
    port: resolveHubPort(installDir, id, config, exclude),
    role,
    ownerNumber: config?.ownerNumber || '',
    listening: describeListening(config, role),
    onboardingComplete: Boolean(config?.onboardingComplete),
    permissionMode: config?.permissionMode || '',
    configured: config !== null,
  };
}

// Accounts created before the hubPort contract, or adopted from a legacy
// single-account install, have no hubPort in their config yet. Allocate one
// lazily and persist it immediately so the same account keeps returning the
// same port on every later call instead of drifting with sort position.
// Nothing is persisted for an account with no config.json at all (nowhere
// safe to write one without inventing its schema) - it still gets a port
// back so callers always see a number, it just is not stable across calls.
function resolveHubPort(installDir, id, config, exclude) {
  const existing = config?.hubPort;
  if (Number.isInteger(existing) && existing > 0) return existing;
  const port = allocatePort(installDir, { exclude });
  if (config) {
    writeJsonAtomic(path.join(accountDir(installDir, id), 'config.json'), { ...config, hubPort: port });
  }
  return port;
}

export function listAccounts(installDir, { exclude = [] } = {}) {
  const ids = existingAccountIds(installDir).sort();
  return ids.map((id, index) => accountSummary(installDir, id, index, { exclude }));
}

export function createAccount(installDir, { id, name, exclude = [] } = {}) {
  if (!isValidAccountId(id)) throw new Error('מזהה חשבון לא חוקי');
  const dir = accountDir(installDir, id);
  if (fs.existsSync(dir)) throw new Error('חשבון עם מזהה זה כבר קיים');

  fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
  const config = {
    ...DEFAULT_CONFIG,
    agentName: String(name ?? '').trim() || id,
    onboardingComplete: false,
    hubPort: allocatePort(installDir, { exclude }),
  };
  writeJsonAtomic(path.join(dir, 'config.json'), config);

  const accounts = listAccounts(installDir, { exclude });
  const index = accounts.findIndex(account => account.id === id);
  return accountSummary(installDir, id, index === -1 ? accounts.length : index, { exclude });
}

export function removeAccount(installDir, id) {
  if (!isValidAccountId(id)) throw new Error('מזהה חשבון לא חוקי');
  fs.rmSync(accountDir(installDir, id), { recursive: true, force: true });
}

// A root config.json alone is NOT evidence of a legacy install: the skill's
// own template ships template/config.json, and installing (or updating)
// copies the whole template into the install dir, so every fresh install
// would otherwise have one. Require actual prior state instead: a saved
// WhatsApp credential file (auth/creds.json, written by Baileys the moment
// pairing succeeds), or a root config that was genuinely filled in - either
// onboarding finished, or an owner number was set mid-onboarding. A pristine
// template copy has none of those: onboardingComplete is false, ownerNumber
// is '', and there is no auth/ dir at all.
export function hasLegacyInstall(installDir) {
  if (fs.existsSync(path.join(installDir, 'auth', 'creds.json'))) return true;
  const config = readRootConfig(installDir);
  return config?.onboardingComplete === true || Boolean(config?.ownerNumber);
}

function readRootConfig(installDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(installDir, 'config.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

export function adoptLegacyInstall(installDir, id = 'main') {
  if (!hasLegacyInstall(installDir)) return { adopted: false };
  if (!isValidAccountId(id)) throw new Error('מזהה חשבון לא חוקי');
  const dir = accountDir(installDir, id);
  if (fs.existsSync(dir)) throw new Error('חשבון עם מזהה זה כבר קיים');

  fs.mkdirSync(dir, { recursive: true });
  // Move auth/ and other state first, config.json LAST. If a move fails
  // partway (EPERM, cross-device rename, ...), config.json is still sitting
  // at the root afterwards, so hasLegacyInstall() keeps reporting true and
  // the stranded auth/feed/session files stay visible for a retry instead of
  // silently going unreported once the sentinel itself is gone.
  for (const dirName of LEGACY_DIRS) {
    const source = path.join(installDir, dirName);
    if (fs.existsSync(source)) fs.renameSync(source, path.join(dir, dirName));
  }
  for (const file of LEGACY_FILES) {
    const source = path.join(installDir, file);
    if (fs.existsSync(source)) fs.renameSync(source, path.join(dir, file));
  }
  const sentinelSource = path.join(installDir, LEGACY_SENTINEL_FILE);
  if (fs.existsSync(sentinelSource)) fs.renameSync(sentinelSource, path.join(dir, LEGACY_SENTINEL_FILE));
  return { adopted: true, id, dir };
}

// ---------- single-instance lock ----------
// The listening port used to be a de-facto mutex: only one bot.js could ever
// bind it, so a second launch failed loudly. The hub now walks past a busy
// port and spawns the child on the next free one instead, so port binding no
// longer stops two bot.js processes from sharing one account directory. Two
// Baileys sockets writing the same multi-file auth state at once corrupts
// the credentials and can double-reply to real contacts, so bot.js takes
// this lock on its own account directory before ever touching WhatsApp.
const LOCK_FILE_NAME = 'bot.pid';

export function lockFilePath(dir) {
  return path.join(dir, LOCK_FILE_NAME);
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the pid exists but is owned by another user - it is alive, we
    // just cannot signal it. Anything else (ESRCH, ...) means it is dead.
    return e.code === 'EPERM';
  }
}

// Attempts to take the lock on `dir` for `pid` (defaults to this process).
// Returns { acquired: true } once the pid file is written. If a live process
// already holds it, returns { acquired: false, pid: <that pid> } without
// touching the file - it is not this caller's to remove. If the pid on disk
// is no longer running (crash, SIGKILL, jetsam - the file was never cleaned
// up), the stale lock is reclaimed automatically and the attempt retried.
export function acquireLock(dir, pid = process.pid) {
  const file = lockFilePath(dir);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return { acquired: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let existingPid = NaN;
    try { existingPid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); } catch (_) {}
    if (Number.isInteger(existingPid) && existingPid > 0 && isPidAlive(existingPid)) {
      return { acquired: false, pid: existingPid };
    }
    try { fs.rmSync(file, { force: true }); } catch (_) {}
  }
  throw new Error('נכשל בנעילת המופע היחיד של החשבון');
}

// Releases the lock on `dir` only if it is still held by `pid` - a lock this
// process does not (or no longer) hold is never removed out from under
// whoever actually owns it.
export function releaseLock(dir, pid = process.pid) {
  const file = lockFilePath(dir);
  try {
    const held = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (held === pid) fs.rmSync(file, { force: true });
  } catch (_) {}
}
