import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  BASE_PORT,
  accountDir,
  accountRole,
  accountsDir,
  accountSummary,
  acquireLock,
  adoptLegacyInstall,
  allocatePort,
  createAccount,
  hasLegacyInstall,
  isPidAlive,
  isValidAccountId,
  listAccounts,
  lockFilePath,
  portForIndex,
  readAccountConfig,
  releaseLock,
  removeAccount,
  slugifyAccountId,
} from '../lib/accounts.js';

function tempInstallDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-accounts-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('portForIndex maps sequential indexes onto sequential ports after the base', () => {
  assert.equal(portForIndex(0), 7655);
  assert.equal(portForIndex(1), 7656);
  assert.equal(portForIndex(2), 7657);
  assert.equal(BASE_PORT, 7654);
});

test('isValidAccountId accepts lowercase alnum + hyphen ids and rejects unsafe ones', () => {
  assert.equal(isValidAccountId('main'), true);
  assert.equal(isValidAccountId('business-2'), true);
  assert.equal(isValidAccountId('a'), true);
  assert.equal(isValidAccountId('a'.repeat(32)), true);

  assert.equal(isValidAccountId(''), false);
  assert.equal(isValidAccountId('..'), false);
  assert.equal(isValidAccountId('../etc'), false);
  assert.equal(isValidAccountId('a/b'), false);
  assert.equal(isValidAccountId('Main'), false);
  assert.equal(isValidAccountId('a'.repeat(33)), false);
});

test('slugifyAccountId falls back to account-N for a pure-Hebrew name', () => {
  const slug = slugifyAccountId('הסוכן שלי');
  assert.match(slug, /^account-\d+$/);
  assert.equal(isValidAccountId(slug), true);
});

test('slugifyAccountId fallback is collision-free against disk state, not time', () => {
  // Reviewer-reproduced bug: the old fallback was `account-${Date.now() % 100000}`,
  // a ~100 second cycle - two Hebrew-only-named accounts created back to back (no
  // real time gap) landed on the *same* generated id and the second create threw
  // "כבר קיים". With installDir passed in, the fallback must probe disk instead.
  const installDir = tempInstallDir();
  try {
    const first = slugifyAccountId('הסוכן שלי', installDir);
    assert.equal(first, 'account-1');
    createAccount(installDir, { id: first, name: 'הסוכן שלי' });

    // Same Hebrew name again, called immediately after (no Date.now() drift at all).
    const second = slugifyAccountId('הסוכן שלי', installDir);
    assert.equal(second, 'account-2');
    assert.notEqual(second, first);
    assert.doesNotThrow(() => createAccount(installDir, { id: second, name: 'הסוכן שלי' }));

    // account-1 is now taken by a *different* purpose (not via the fallback) -
    // the probe must skip it and land on the next free slot, not reuse it.
    const third = slugifyAccountId('שוב עברית', installDir);
    assert.equal(third, 'account-3');
  } finally {
    cleanup(installDir);
  }
});

test('slugifyAccountId without installDir keeps the documented time-based fallback', () => {
  const slug = slugifyAccountId('הסוכן שלי');
  assert.match(slug, /^account-\d+$/);
  assert.equal(isValidAccountId(slug), true);
});

test('slugifyAccountId derives a valid id from a latin name', () => {
  assert.equal(slugifyAccountId('Business Number'), 'business-number');
  assert.equal(isValidAccountId(slugifyAccountId('Business Number')), true);
});

test('createAccount seeds a config with onboardingComplete false and listAccounts sees it', () => {
  const installDir = tempInstallDir();
  try {
    const created = createAccount(installDir, { id: 'main', name: 'עסק' });
    assert.equal(created.id, 'main');
    assert.equal(created.onboardingComplete, false);
    assert.equal(created.configured, true);
    assert.equal(created.role, 'unconfigured');

    const configPath = path.join(accountDir(installDir, 'main'), 'config.json');
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(savedConfig.onboardingComplete, false);
    assert.equal(savedConfig.agentName, 'עסק');
    assert.equal(fs.existsSync(path.join(accountDir(installDir, 'main'), 'auth')), true);

    const accounts = listAccounts(installDir);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, 'main');
    assert.equal(accounts[0].port, portForIndex(0));

    assert.throws(() => createAccount(installDir, { id: 'main', name: 'again' }), /כבר קיים/);
    assert.throws(() => createAccount(installDir, { id: '..', name: 'bad' }), /לא חוקי/);
  } finally {
    cleanup(installDir);
  }
});

test('listAccounts sorts by id, but ports are stable per-account, not derived from that sort position', () => {
  const installDir = tempInstallDir();
  try {
    // personal is created first so it must get the first port, even though it
    // sorts *after* business alphabetically - proving the port comes from
    // creation order (allocatePort/hubPort), never from listAccounts' sort.
    const personal = createAccount(installDir, { id: 'personal', name: 'אישי' });
    const business = createAccount(installDir, { id: 'business', name: 'עסקי' });
    assert.equal(personal.port, BASE_PORT + 1);
    assert.equal(business.port, BASE_PORT + 2);

    const accounts = listAccounts(installDir);
    assert.deepEqual(accounts.map(a => a.id), ['business', 'personal']);
    const byId = Object.fromEntries(accounts.map(a => [a.id, a.port]));
    assert.equal(byId.personal, personal.port);
    assert.equal(byId.business, business.port);
    // The old contract would have required this (position 0 in the sorted
    // list = portForIndex(0)); the new contract must NOT match it, since
    // business ends up first in sort order but was created second.
    assert.notEqual(byId.business, portForIndex(0));
  } finally {
    cleanup(installDir);
  }
});

test('adding or removing a sibling account never shifts an existing account\'s port', () => {
  // This is the exact scenario the review reproduced against the old
  // sort-position contract: business:7655, personal:7656 -> adopt "main" ->
  // business:7655, main:7656, personal:7657 (personal's port moved under it).
  const installDir = tempInstallDir();
  try {
    const business = createAccount(installDir, { id: 'business', name: 'עסקי' });
    const personal = createAccount(installDir, { id: 'personal', name: 'אישי' });
    assert.equal(business.port, BASE_PORT + 1);
    assert.equal(personal.port, BASE_PORT + 2);

    const main = createAccount(installDir, { id: 'main', name: 'ראשי' });
    assert.equal(main.port, BASE_PORT + 3);

    const afterAdd = listAccounts(installDir);
    const byId = Object.fromEntries(afterAdd.map(a => [a.id, a.port]));
    assert.equal(byId.business, business.port);
    assert.equal(byId.personal, personal.port);
    assert.equal(byId.main, main.port);

    removeAccount(installDir, 'main');
    const afterRemove = listAccounts(installDir);
    const byIdAfterRemove = Object.fromEntries(afterRemove.map(a => [a.id, a.port]));
    assert.equal(byIdAfterRemove.business, business.port);
    assert.equal(byIdAfterRemove.personal, personal.port);
  } finally {
    cleanup(installDir);
  }
});

test('allocatePort returns the lowest free port, filling a gap left by a removed or high-numbered account', () => {
  const installDir = tempInstallDir();
  try {
    assert.equal(allocatePort(installDir), BASE_PORT + 1);

    createAccount(installDir, { id: 'a', name: 'a' }); // takes BASE_PORT + 1
    assert.equal(allocatePort(installDir), BASE_PORT + 2);

    // An account with a manually-set, far-away hubPort must not make
    // allocatePort skip ahead - the gap right after "a" is still free.
    fs.mkdirSync(path.join(accountDir(installDir, 'b'), 'auth'), { recursive: true });
    fs.writeFileSync(path.join(accountDir(installDir, 'b'), 'config.json'), JSON.stringify({ hubPort: BASE_PORT + 50 }));
    assert.equal(allocatePort(installDir), BASE_PORT + 2);
  } finally {
    cleanup(installDir);
  }
});

test('allocatePort never returns a port in the exclude list, even if no account claims it', () => {
  const installDir = tempInstallDir();
  try {
    // This is how a hub server protects its own listening port: pass it as
    // exclude so a lazily-allocated child port can never collide with it.
    assert.equal(allocatePort(installDir, { exclude: [BASE_PORT + 1] }), BASE_PORT + 2);
    assert.equal(allocatePort(installDir, { exclude: [BASE_PORT + 1, BASE_PORT + 2] }), BASE_PORT + 3);
  } finally {
    cleanup(installDir);
  }
});

test('createAccount persists hubPort into the account\'s own config.json', () => {
  const installDir = tempInstallDir();
  try {
    const created = createAccount(installDir, { id: 'main', name: 'עסק' });
    assert.equal(created.port, BASE_PORT + 1);

    const configPath = path.join(accountDir(installDir, 'main'), 'config.json');
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(savedConfig.hubPort, BASE_PORT + 1);
  } finally {
    cleanup(installDir);
  }
});

test('accountSummary lazily allocates and persists hubPort for an account that predates the contract', () => {
  const installDir = tempInstallDir();
  try {
    // Simulate an account created before this change, or adopted from a
    // legacy install: a config.json with no hubPort field at all.
    const dir = accountDir(installDir, 'legacy');
    fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ ownerNumber: '972500000000', onboardingComplete: true }));
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).hubPort, undefined);

    const first = accountSummary(installDir, 'legacy', 0);
    assert.equal(first.port, BASE_PORT + 1);
    // Persisted, not just returned in memory.
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).hubPort, BASE_PORT + 1);
    // Every other field survives the rewrite untouched.
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).ownerNumber, '972500000000');

    // Calling it again must return the SAME port - stable, not re-derived.
    const second = accountSummary(installDir, 'legacy', 0);
    assert.equal(second.port, BASE_PORT + 1);
  } finally {
    cleanup(installDir);
  }
});

test('listAccounts threads its exclude option through to lazy hubPort allocation', () => {
  const installDir = tempInstallDir();
  try {
    const dir = accountDir(installDir, 'legacy');
    fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ownerNumber: '972500000000' }));

    // Without exclude the account would land on BASE_PORT + 1; simulate a
    // hub already listening there.
    const accounts = listAccounts(installDir, { exclude: [BASE_PORT + 1] });
    assert.equal(accounts[0].port, BASE_PORT + 2);
  } finally {
    cleanup(installDir);
  }
});

test('createAccount threads exclude through to hubPort allocation, so it can never claim the caller\'s own port', () => {
  const installDir = tempInstallDir();
  try {
    // Reviewer-proved bug: with the hub listening on PORT=7655, createAccount
    // persisted hubPort 7655 too - it had no exclude to protect the hub's
    // own port, unlike every read path (listAccounts/accountSummary), which
    // already threaded { exclude: [PORT] }. Simulate the same setup here.
    const created = createAccount(installDir, { id: 'main', name: 'עסק', exclude: [BASE_PORT + 1] });
    assert.equal(created.port, BASE_PORT + 2);

    const configPath = path.join(accountDir(installDir, 'main'), 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).hubPort, BASE_PORT + 2);
  } finally {
    cleanup(installDir);
  }
});

test('removeAccount deletes the account directory and rejects invalid ids', () => {
  const installDir = tempInstallDir();
  try {
    createAccount(installDir, { id: 'main', name: 'עסק' });
    assert.equal(fs.existsSync(accountDir(installDir, 'main')), true);
    removeAccount(installDir, 'main');
    assert.equal(fs.existsSync(accountDir(installDir, 'main')), false);
    assert.deepEqual(listAccounts(installDir), []);

    assert.throws(() => removeAccount(installDir, '../evil'), /לא חוקי/);
  } finally {
    cleanup(installDir);
  }
});

test('accountRole covers all four configuration states', () => {
  assert.equal(accountRole(null), 'unconfigured');
  assert.equal(accountRole({}), 'unconfigured');
  assert.equal(accountRole({ ownerNumber: '972500000000' }), 'separate-number');
  assert.equal(accountRole({ singleNumberMode: true, ownerNumber: '972500000000' }), 'one-number');
  assert.equal(accountRole({ groupPublicMode: true, ownerNumber: '972500000000' }), 'group-bot');
  // groupPublicMode wins over singleNumberMode when both are somehow set.
  assert.equal(
    accountRole({ groupPublicMode: true, singleNumberMode: true, ownerNumber: '972500000000' }),
    'group-bot',
  );
});

test('accountSummary derives Hebrew listening text from the account role', () => {
  const installDir = tempInstallDir();
  try {
    fs.mkdirSync(path.join(accountDir(installDir, 'self'), 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(accountDir(installDir, 'self'), 'config.json'),
      JSON.stringify({ singleNumberMode: true, ownerNumber: '972500000000', allowedChats: [] }),
    );
    const selfChat = accountSummary(installDir, 'self', 0);
    assert.equal(selfChat.listening, 'צ׳אט עצמי');

    fs.mkdirSync(path.join(accountDir(installDir, 'group'), 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(accountDir(installDir, 'group'), 'config.json'),
      JSON.stringify({ singleNumberMode: true, ownerNumber: '972500000000', allowedChats: ['1@g.us'] }),
    );
    const groupChat = accountSummary(installDir, 'group', 1);
    assert.equal(groupChat.listening, 'קבוצה פרטית');

    const emptyDirId = 'unconfigured-account';
    fs.mkdirSync(accountDir(installDir, emptyDirId), { recursive: true });
    const unconfigured = accountSummary(installDir, emptyDirId, 2);
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.listening, 'לא מוגדר');
    assert.equal(unconfigured.name, emptyDirId);

    assert.equal(readAccountConfig(installDir, 'does-not-exist'), null);
  } finally {
    cleanup(installDir);
  }
});

test('hasLegacyInstall is NOT fooled by a pristine template copy (root config.json alone is not evidence)', () => {
  // Reproduces the reviewer's bug exactly: SKILL.md step 3 does
  // `cp -R "$SKILL_DIR/template/." "$INSTALL/"`, which ships template/config.json
  // (onboardingComplete: false, ownerNumber: '') at the install root on EVERY
  // fresh install and every update - not just on a real prior single-account run.
  const installDir = tempInstallDir();
  try {
    // This is the exact content the skill ships in template/config.json.
    fs.writeFileSync(
      path.join(installDir, 'config.json'),
      JSON.stringify({
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
        systemPromptAppend: '',
        permissionMode: 'bypassPermissions',
        openaiApiKey: '',
        ttsMode: 'mirror',
        ttsVoice: 'alloy',
      }),
    );

    assert.equal(hasLegacyInstall(installDir), false);
    assert.deepEqual(adoptLegacyInstall(installDir, 'main'), { adopted: false });
    // A pristine template copy must never phantom-adopt a "main" account.
    assert.deepEqual(listAccounts(installDir), []);
  } finally {
    cleanup(installDir);
  }
});

test('hasLegacyInstall is true once onboarding actually completed', () => {
  const installDir = tempInstallDir();
  try {
    fs.writeFileSync(
      path.join(installDir, 'config.json'),
      JSON.stringify({ ownerNumber: '972500000000', onboardingComplete: true }),
    );
    assert.equal(hasLegacyInstall(installDir), true);
  } finally {
    cleanup(installDir);
  }
});

test('hasLegacyInstall is true when ownerNumber was set mid-onboarding, even before onboardingComplete flips', () => {
  const installDir = tempInstallDir();
  try {
    fs.writeFileSync(
      path.join(installDir, 'config.json'),
      JSON.stringify({ ownerNumber: '972500000000', onboardingComplete: false }),
    );
    assert.equal(hasLegacyInstall(installDir), true);
  } finally {
    cleanup(installDir);
  }
});

test('hasLegacyInstall is true from a saved WhatsApp credential file alone, even with a pristine config.json', () => {
  const installDir = tempInstallDir();
  try {
    fs.writeFileSync(
      path.join(installDir, 'config.json'),
      JSON.stringify({ ownerNumber: '', onboardingComplete: false }),
    );
    fs.mkdirSync(path.join(installDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'auth', 'creds.json'), '{}');
    assert.equal(hasLegacyInstall(installDir), true);
  } finally {
    cleanup(installDir);
  }
});

test('hasLegacyInstall is false with no config.json and no auth/creds.json at all', () => {
  const installDir = tempInstallDir();
  try {
    assert.equal(hasLegacyInstall(installDir), false);
  } finally {
    cleanup(installDir);
  }
});

test('adoptLegacyInstall moves legacy top-level files into accounts/<id> and is idempotent', () => {
  const installDir = tempInstallDir();
  try {
    assert.equal(hasLegacyInstall(installDir), false);
    assert.deepEqual(adoptLegacyInstall(installDir, 'main'), { adopted: false });

    fs.writeFileSync(
      path.join(installDir, 'config.json'),
      JSON.stringify({ ownerNumber: '972500000000', onboardingComplete: true }),
    );
    fs.writeFileSync(path.join(installDir, 'feed.json'), '[]');
    fs.writeFileSync(path.join(installDir, 'sessions.json'), '{}');
    fs.writeFileSync(path.join(installDir, 'bot.log'), 'hello\n');
    fs.writeFileSync(path.join(installDir, 'sent-message-ids.json'), '[]');
    fs.writeFileSync(path.join(installDir, 'processed-message-ids.json'), '[]');
    fs.mkdirSync(path.join(installDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'auth', 'creds.json'), '{}');
    fs.mkdirSync(path.join(installDir, 'media'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'media', 'pic.jpg'), 'binary');
    // A file adoptLegacyInstall must leave untouched.
    fs.writeFileSync(path.join(installDir, 'launcher.log'), 'unrelated\n');

    assert.equal(hasLegacyInstall(installDir), true);
    const result = adoptLegacyInstall(installDir, 'main');
    assert.equal(result.adopted, true);
    assert.equal(result.id, 'main');

    const dir = accountDir(installDir, 'main');
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'feed.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'sessions.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'bot.log')), true);
    assert.equal(fs.existsSync(path.join(dir, 'sent-message-ids.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'processed-message-ids.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'auth', 'creds.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'media', 'pic.jpg')), true);

    // Nothing was left behind at the top level except what it must not touch.
    assert.equal(fs.existsSync(path.join(installDir, 'config.json')), false);
    assert.equal(fs.existsSync(path.join(installDir, 'auth')), false);
    assert.equal(fs.existsSync(path.join(installDir, 'media')), false);
    assert.equal(fs.existsSync(path.join(installDir, 'launcher.log')), true);

    // Idempotent: nothing left to move now that config.json is gone.
    assert.deepEqual(adoptLegacyInstall(installDir, 'other'), { adopted: false });
    assert.deepEqual(listAccounts(installDir).map(a => a.id), ['main']);
  } finally {
    cleanup(installDir);
  }
});

test('adoptLegacyInstall refuses to overwrite an existing account directory', () => {
  const installDir = tempInstallDir();
  try {
    createAccount(installDir, { id: 'main', name: 'existing' });
    fs.writeFileSync(
      path.join(installDir, 'config.json'),
      JSON.stringify({ ownerNumber: '972500000000', onboardingComplete: true }),
    );

    assert.equal(hasLegacyInstall(installDir), true);
    assert.throws(() => adoptLegacyInstall(installDir, 'main'), /כבר קיים/);

    // Nothing was moved: the legacy config.json is still at the top level,
    // and the pre-existing account config was not touched.
    assert.equal(fs.existsSync(path.join(installDir, 'config.json')), true);
    const preserved = readAccountConfig(installDir, 'main');
    assert.equal(preserved.agentName, 'existing');
  } finally {
    cleanup(installDir);
  }
});

test('adoptLegacyInstall moves auth/ before config.json, so a partial failure leaves the sentinel reporting true', (t) => {
  const installDir = tempInstallDir();
  try {
    fs.writeFileSync(
      path.join(installDir, 'config.json'),
      JSON.stringify({ ownerNumber: '972500000000', onboardingComplete: true }),
    );
    fs.mkdirSync(path.join(installDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'auth', 'creds.json'), '{}');
    fs.writeFileSync(path.join(installDir, 'sessions.json'), '{}');

    // Force the sessions.json move specifically to fail partway through,
    // without disturbing any other rename (in particular without pre-creating
    // accounts/main/ ourselves, which would trip the "already exists" guard
    // before the real move logic even runs).
    const sessionsSource = path.join(installDir, 'sessions.json');
    const originalRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, dest) => {
      if (source === sessionsSource) {
        throw Object.assign(new Error('EISDIR: simulated failure for test'), { code: 'EISDIR' });
      }
      return originalRename.call(fs, source, dest);
    });

    assert.throws(() => adoptLegacyInstall(installDir, 'main'), /EISDIR/);

    // auth/ is a LEGACY_DIRS entry and must have moved BEFORE the failure,
    // since dirs are moved first.
    const dir = accountDir(installDir, 'main');
    assert.equal(fs.existsSync(path.join(dir, 'auth', 'creds.json')), true);
    assert.equal(fs.existsSync(path.join(installDir, 'auth')), false);

    // config.json is the sentinel and must be moved LAST - it is still at
    // the root because the function threw before ever reaching it.
    assert.equal(fs.existsSync(path.join(installDir, 'config.json')), true);
    assert.equal(hasLegacyInstall(installDir), true);

    // The file that actually failed to move is still visible at the root too
    // (nothing was silently lost), not moved and not deleted.
    assert.equal(fs.existsSync(sessionsSource), true);
  } finally {
    cleanup(installDir);
  }
});

test('accountsDir and accountDir compose the expected layout', () => {
  const installDir = '/tmp/example-install';
  assert.equal(accountsDir(installDir), path.join(installDir, 'accounts'));
  assert.equal(accountDir(installDir, 'main'), path.join(installDir, 'accounts', 'main'));
});

// A real pid that has already exited by the time spawnSync returns - the OS
// has reaped it, so process.kill(pid, 0) reports ESRCH exactly like a
// crashed bot.js that never got to clean up its own lock file.
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

test('acquireLock takes a fresh lock and writes this process\'s pid', () => {
  const installDir = tempInstallDir();
  try {
    assert.deepEqual(acquireLock(installDir), { acquired: true });
    assert.equal(fs.readFileSync(lockFilePath(installDir), 'utf8'), String(process.pid));
  } finally {
    cleanup(installDir);
  }
});

test('acquireLock refuses when a live process already holds the lock, and leaves that lock untouched', () => {
  const installDir = tempInstallDir();
  try {
    // This process is, definitionally, alive - stand in for "some other
    // bot.js instance is already running against this account directory".
    fs.writeFileSync(lockFilePath(installDir), String(process.pid));
    assert.deepEqual(acquireLock(installDir), { acquired: false, pid: process.pid });
    // Refused, not stolen - the file on disk still names the live holder.
    assert.equal(fs.readFileSync(lockFilePath(installDir), 'utf8'), String(process.pid));
  } finally {
    cleanup(installDir);
  }
});

test('acquireLock reclaims a stale lock left by a pid that is no longer running', () => {
  const installDir = tempInstallDir();
  try {
    fs.writeFileSync(lockFilePath(installDir), String(deadPid()));
    assert.deepEqual(acquireLock(installDir), { acquired: true });
    // The stale pid was replaced with this process's own, not left in place.
    assert.equal(fs.readFileSync(lockFilePath(installDir), 'utf8'), String(process.pid));
  } finally {
    cleanup(installDir);
  }
});

test('acquireLock reclaims a corrupt or empty lock file the same way as a stale one', () => {
  const installDir = tempInstallDir();
  try {
    fs.writeFileSync(lockFilePath(installDir), '');
    assert.deepEqual(acquireLock(installDir), { acquired: true });
  } finally {
    cleanup(installDir);
  }
});

test('isPidAlive reports true for this process and false for one that already exited', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(deadPid()), false);
});

test('releaseLock removes the lock only when it still names the given pid', () => {
  const installDir = tempInstallDir();
  try {
    fs.writeFileSync(lockFilePath(installDir), String(process.pid));
    // A different pid releasing must not drop a lock it does not hold.
    releaseLock(installDir, process.pid + 1);
    assert.equal(fs.existsSync(lockFilePath(installDir)), true);

    releaseLock(installDir, process.pid);
    assert.equal(fs.existsSync(lockFilePath(installDir)), false);
  } finally {
    cleanup(installDir);
  }
});

test('releaseLock on a directory with no lock file is a silent no-op', () => {
  const installDir = tempInstallDir();
  try {
    assert.doesNotThrow(() => releaseLock(installDir));
  } finally {
    cleanup(installDir);
  }
});
