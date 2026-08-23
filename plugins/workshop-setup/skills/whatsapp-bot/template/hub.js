#!/usr/bin/env node
// WhatsApp hub - lists and controls one bot.js child process per account
import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { readBody, requestAccessError } from './lib/http-core.js';
import { writeJsonAtomic } from './lib/bot-core.js';
import {
  BASE_PORT,
  accountDir,
  isValidAccountId,
  slugifyAccountId,
  listAccounts,
  createAccount,
  removeAccount,
  hasLegacyInstall,
  adoptLegacyInstall,
  allocatePort,
  readAccountConfig,
} from './lib/accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = __dirname;
const BOT_PATH = path.join(__dirname, 'bot.js');
const HUB_HTML_PATH = path.join(__dirname, 'hub.html');
const PORT = parseInt(process.env.PORT || String(BASE_PORT), 10);
const LOCAL_HOST = '127.0.0.1';
const LOCAL_URL = `http://${LOCAL_HOST}:${PORT}`;
const UI_TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_AUTO_RESTARTS = 3;
const AUTO_RESTART_DELAY_MS = 1500;
const HEALTH_TIMEOUT_MS = 2000;
const STOP_TIMEOUT_MS = 5000;
// A child that stays up this long counts as healthy - its restart counter
// resets so an account that crashes once every few weeks never creeps
// toward MAX_AUTO_RESTARTS and gets stranded "off" by an unrelated blip.
const HEALTHY_UPTIME_MS = 5 * 60 * 1000;

function log(...args) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${args.join(' ')}`;
  console.log(line);
}

// ---------- child process registry ----------
// id -> { id, port, proc, restarts, crashed, exited, stoppedManually, restartTimer, healthyTimer }
const children = new Map();
// id -> in-flight spawnChild() promise, so two overlapping callers (e.g. the
// startup loop racing a manual "start" click) can never both pass the "no
// live entry yet" check and end up spawning two processes onto one auth dir.
const spawning = new Map();
// ids with a stop/delete racing an in-flight spawn from the set above. Set
// synchronously (before awaiting the in-flight spawn promise) so that if the
// spawn's very first event is an immediate 'error' or 'exit' - which can fire
// before stopChild's own continuation gets a turn - it is still treated as a
// deliberate stop instead of an unexpected crash that the restart budget
// reacts to.
const cancelling = new Set();
// Hebrew reasons for accounts the startup loop skipped or failed to spawn,
// surfaced to the UI via GET /api/accounts instead of only reaching the
// terminal log.
const startupWarnings = [];

// The hub's own listening port must never be handed to a child - exclude it
// from every port lookup so an account whose stored hubPort is missing (a
// pre-contract account, or one adopted from a legacy install) can't get
// lazily assigned the port the hub itself is bound to.
function getAccounts() {
  return listAccounts(INSTALL_DIR, { exclude: [PORT] });
}

function findAccount(id) {
  return getAccounts().find(a => a.id === id) || null;
}

// Probe an actual OS-level bind on 127.0.0.1 - this is the only way to see
// a port held by something outside this hub's own account registry (another
// program, a leftover process from a previous run, ...).
function probePortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, LOCAL_HOST, () => srv.close(() => resolve(true)));
  });
}

function persistHubPort(id, port) {
  const config = readAccountConfig(INSTALL_DIR, id);
  if (!config) return;
  writeJsonAtomic(path.join(accountDir(INSTALL_DIR, id), 'config.json'), { ...config, hubPort: port });
}

// The account's persisted hubPort is the port of record, but it can still be
// occupied by something this hub doesn't know about (another process, a
// stale listener). Probe before trusting it, and if it's taken, allocate and
// persist a real replacement instead of silently colliding.
async function resolveSpawnPort(summary) {
  const { id, port: desiredPort } = summary;
  if (await probePortFree(desiredPort)) return desiredPort;

  const excluded = new Set([PORT, desiredPort]);
  for (let i = 0; i < 200; i++) {
    const candidate = allocatePort(INSTALL_DIR, { exclude: [...excluded] });
    if (await probePortFree(candidate)) {
      persistHubPort(id, candidate);
      return candidate;
    }
    excluded.add(candidate);
  }
  throw new Error(`לא נמצא פורט פנוי עבור "${id}"`);
}

function spawnChild(summary, restarts = 0) {
  const { id } = summary;
  const current = children.get(id);
  if (current && !current.exited) return Promise.resolve(current);
  if (spawning.has(id)) return spawning.get(id);

  const promise = spawnChildNow(summary, restarts).finally(() => {
    if (spawning.get(id) === promise) spawning.delete(id);
  });
  spawning.set(id, promise);
  return promise;
}

async function spawnChildNow(summary, restarts) {
  const { id, dir } = summary;
  const port = await resolveSpawnPort(summary);
  if (port !== summary.port) {
    log(`⚠️ הפורט ${summary.port} עבור "${id}" תפוס, עובר לפורט ${port}`);
  }

  const entry = {
    id, port, proc: null, restarts, crashed: false, exited: false,
    stoppedManually: false, lastError: null, restartTimer: null, healthyTimer: null,
    ready: false, readyTimer: null,
  };
  // A stop/delete raced this spawn while it was awaiting resolveSpawnPort()
  // above - stopChild already added us to `cancelling` before that await
  // could resolve (both run on the same JS thread, so there is no ordering
  // where it could see this entry and NOT have set the flag by now). Mark it
  // stopped up front so an immediate spawn failure (EAGAIN/EMFILE/ENOMEM)
  // can never race downChild() into treating this as an unexpected crash and
  // spending the restart budget on a start that was already cancelled.
  if (cancelling.has(id)) entry.stoppedManually = true;
  const proc = spawn(process.execPath, [BOT_PATH], {
    cwd: INSTALL_DIR,
    env: { ...process.env, WA_ACCOUNT_DIR: dir, PORT: String(port), WA_LAUNCH_SILENT: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  entry.proc = proc;

  entry.healthyTimer = setTimeout(() => {
    entry.healthyTimer = null;
    if (children.get(id) === entry && !entry.exited) entry.restarts = 0;
  }, HEALTHY_UPTIME_MS);

  // A failed spawn (EAGAIN/EMFILE/ENOMEM, ...) emits 'error' and Node does
  // not guarantee an 'exit' event follows it. Route both through the same
  // bookkeeping so a spawn failure can never leave the entry looking
  // permanently "running": the start button's `!current.exited` guard would
  // otherwise be a no-op forever and /health would keep proxying to a port
  // this hub no longer owns.
  proc.on('error', err => downChild(id, entry, { errorMessage: err.message }));
  proc.on('exit', (code, signal) => downChild(id, entry, { code, signal }));

  children.set(id, entry);
  watchReady(entry);
  return entry;
}

// Shared by both the 'error' and 'exit' listeners above. Node may deliver
// both events for one failed spawn, so this must be idempotent - the
// `entry.exited` guard makes the second call a no-op regardless of which
// event arrives first.
function downChild(id, entry, { code, signal, errorMessage } = {}) {
  if (entry.exited) return;
  entry.exited = true;
  entry.ready = false;
  entry.lastError = errorMessage || null;
  if (entry.healthyTimer) { clearTimeout(entry.healthyTimer); entry.healthyTimer = null; }
  if (entry.readyTimer) { clearTimeout(entry.readyTimer); entry.readyTimer = null; }
  if (entry.stoppedManually) {
    log(`⏹️ "${id}" נעצר`);
    return;
  }
  if (errorMessage) {
    log(`⚠️ שגיאה בהפעלת "${id}":`, errorMessage);
  } else {
    log(`⚠️ "${id}" נסגר באופן לא צפוי (code=${code ?? '-'} signal=${signal ?? '-'})`);
  }
  if (entry.restarts >= MAX_AUTO_RESTARTS) {
    entry.crashed = true;
    log(`⛔ "${id}" הגיע למגבלת ההפעלות מחדש (${MAX_AUTO_RESTARTS}), נשאר כבוי`);
    return;
  }
  const nextRestarts = entry.restarts + 1;
  entry.restartTimer = setTimeout(() => {
    entry.restartTimer = null;
    // Skip if a manual start/stop/delete already replaced or removed this entry.
    if (children.get(id) !== entry) return;
    const latest = findAccount(id);
    if (!latest) return;
    log(`🔁 מפעיל מחדש את "${id}" (ניסיון ${nextRestarts}/${MAX_AUTO_RESTARTS})`);
    spawnChild(latest, nextRestarts).catch(e => log(`⚠️ שגיאה בהפעלה מחדש של "${id}":`, e.message));
  }, AUTO_RESTART_DELAY_MS);
}

async function stopChild(id, { timeoutMs = STOP_TIMEOUT_MS } = {}) {
  // The `spawning` map is exactly what serializes this against a start still
  // in flight: children.set(id, entry) only happens after spawnChildNow's
  // await, so a stop landing in that window would otherwise find nothing to
  // act on and return immediately while the new child comes up anyway. Add
  // to `cancelling` BEFORE the await below (synchronously, so spawnChildNow
  // can never miss it - see the comment on `cancelling` above) and wait for
  // the in-flight spawn to finish registering itself before touching it.
  const pending = spawning.get(id);
  if (pending) {
    cancelling.add(id);
    try { await pending; } catch (_) { /* spawnChildNow already logs its own failures */ }
    finally { cancelling.delete(id); }
  }

  const entry = children.get(id);
  if (!entry) return false;

  // Always cancel any pending auto-restart and mark this as a deliberate
  // stop, even if the child has already exited - otherwise a stop issued
  // during the auto-restart window is a no-op and the account comes back up
  // on its own a couple seconds later.
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
  entry.stoppedManually = true;

  if (entry.exited) return false;
  return new Promise(resolve => {
    let settled = false;
    entry.proc.once('exit', () => { if (!settled) { settled = true; resolve(true); } });
    try { entry.proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      if (settled) return;
      try { entry.proc.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
  });
}

function proxyHealth(port) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const req = http.get({ host: LOCAL_HOST, port, path: '/state', timeout: HEALTH_TIMEOUT_MS }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { finish({ ok: true, state: JSON.parse(data) }); }
        catch (_) { finish({ ok: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false }); });
    req.on('error', () => finish({ ok: false }));
  });
}

// A live child keeps the exact port it was actually bound to. That can only
// ever differ from the account's persisted hubPort for the instant between
// resolveSpawnPort() relocating around a collision and its persist call
// landing - by the time this is read again both already agree. A stopped
// account just shows its persisted hubPort.
function livePort(summary) {
  const child = children.get(summary.id);
  return (child && !child.exited) ? child.port : summary.port;
}

// A freshly spawned bot.js reports "running" the moment the process exists, but
// it does not bind its port for another few seconds (longer on a cold start).
// The dashboard button used to go live in that window and opened onto nothing.
// Probe the child's port until it actually accepts a connection, and only then
// call the account ready.
const READY_PROBE_INTERVAL_MS = 500;
const READY_PROBE_TIMEOUT_MS = 60_000;

function probePort(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: LOCAL_HOST, port });
    const done = ok => { socket.removeAllListeners(); socket.destroy(); resolve(ok); };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

function watchReady(entry) {
  const deadline = Date.now() + READY_PROBE_TIMEOUT_MS;
  const tick = async () => {
    if (entry.exited || entry.ready) return;
    if (await probePort(entry.port)) {
      if (!entry.exited) entry.ready = true;
      return;
    }
    if (Date.now() >= deadline || entry.exited) return;
    entry.readyTimer = setTimeout(tick, READY_PROBE_INTERVAL_MS);
  };
  entry.readyTimer = setTimeout(tick, READY_PROBE_INTERVAL_MS);
}

function accountsPayload() {
  return getAccounts().map(summary => {
    const child = children.get(summary.id);
    const running = !!child && !child.exited;
    const port = livePort(summary);
    return {
      ...summary,
      port,
      status: running ? 'running' : 'stopped',
      ready: running && !!child.ready,
      url: `http://${LOCAL_HOST}:${port}`,
      restarts: child ? child.restarts : 0,
      crashed: child ? child.crashed : false,
    };
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Mirrors bot.js's own readIndex(): the token is templated into the page
// itself instead of being handed out from a dedicated GET route that any
// unauthenticated local request could hit.
function readHub() {
  try { return fs.readFileSync(HUB_HTML_PATH, 'utf8').replaceAll('__UI_TOKEN__', UI_TOKEN); }
  catch (_) { return '<h1>hub.html missing</h1>'; }
}

// ---------- HTTP server ----------
const ROUTE_START = /^\/api\/accounts\/([^/]+)\/start$/;
const ROUTE_STOP = /^\/api\/accounts\/([^/]+)\/stop$/;
const ROUTE_HEALTH = /^\/api\/accounts\/([^/]+)\/health$/;
const ROUTE_ONE = /^\/api\/accounts\/([^/]+)$/;

const server = http.createServer(async (req, res) => {
  try {
    const accessError = requestAccessError(req, { expectedToken: UI_TOKEN, port: PORT });
    if (accessError) return sendJson(res, accessError.status, { error: accessError.code });

    const { pathname } = new URL(req.url, `http://${LOCAL_HOST}`);
    const method = req.method || 'GET';

    if (pathname === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readHub());
    }

    if (pathname === '/api/accounts' && method === 'GET') {
      return sendJson(res, 200, { accounts: accountsPayload(), warnings: startupWarnings });
    }

    if (pathname === '/api/accounts' && method === 'POST') {
      const body = await readBody(req);
      let name;
      try { ({ name } = JSON.parse(body || '{}')); }
      catch (_) { return sendJson(res, 400, { error: 'גוף הבקשה אינו JSON תקין' }); }
      name = String(name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'שם חשבון חסר' });
      const id = slugifyAccountId(name, INSTALL_DIR);
      if (!isValidAccountId(id)) return sendJson(res, 400, { error: 'מזהה חשבון לא תקין' });
      try { createAccount(INSTALL_DIR, { id, name, exclude: [PORT] }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      const created = findAccount(id);
      log(`➕ נוצר חשבון חדש: "${name}" (${id})`);
      if (!created) return sendJson(res, 500, { error: 'יצירת החשבון נכשלה' });
      return sendJson(res, 200, { ...created, status: 'stopped', url: `http://${LOCAL_HOST}:${created.port}` });
    }

    let match;
    if ((match = pathname.match(ROUTE_START)) && method === 'POST') {
      const id = match[1];
      if (!isValidAccountId(id)) return sendJson(res, 400, { error: 'מזהה חשבון לא תקין' });
      const summary = findAccount(id);
      if (!summary) return sendJson(res, 404, { error: 'החשבון אינו קיים' });
      const child = await spawnChild(summary);
      log(`▶️ הופעל: "${id}"`);
      return sendJson(res, 200, { ...summary, port: child.port, status: 'running', url: `http://${LOCAL_HOST}:${child.port}` });
    }

    if ((match = pathname.match(ROUTE_STOP)) && method === 'POST') {
      const id = match[1];
      if (!isValidAccountId(id)) return sendJson(res, 400, { error: 'מזהה חשבון לא תקין' });
      if (!fs.existsSync(accountDir(INSTALL_DIR, id))) return sendJson(res, 404, { error: 'החשבון אינו קיים' });
      await stopChild(id);
      log(`⏹️ נעצר: "${id}"`);
      return sendJson(res, 200, { ok: true });
    }

    if ((match = pathname.match(ROUTE_HEALTH)) && method === 'GET') {
      const id = match[1];
      if (!isValidAccountId(id)) return sendJson(res, 400, { ok: false, error: 'מזהה חשבון לא תקין' });
      const summary = findAccount(id);
      if (!summary) return sendJson(res, 404, { ok: false, error: 'החשבון אינו קיים' });
      const child = children.get(id);
      // Never proxy to a port this hub doesn't currently own - an account
      // with no live child of this hub has no state to report, whatever its
      // persisted hubPort says.
      if (!child || child.exited) return sendJson(res, 200, { ok: false });
      const result = await proxyHealth(child.port);
      return sendJson(res, 200, result);
    }

    if ((match = pathname.match(ROUTE_ONE)) && method === 'DELETE') {
      const id = match[1];
      if (!isValidAccountId(id)) return sendJson(res, 400, { error: 'מזהה חשבון לא תקין' });
      if (!fs.existsSync(accountDir(INSTALL_DIR, id))) return sendJson(res, 404, { error: 'החשבון אינו קיים' });
      await stopChild(id);
      children.delete(id);
      removeAccount(INSTALL_DIR, id);
      log(`🗑️ נמחק חשבון: "${id}"`);
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404); res.end();
  } catch (e) {
    log('http err:', e.message);
    try { sendJson(res, e.statusCode || 500, { error: e.message }); } catch (_) {}
  }
});

// A failed bind (e.g. EADDRINUSE from a second "npm start") must stop the
// hub before it touches a single account directory. Registering this BEFORE
// listen() means Node reports the failure here instead of throwing it as an
// uncaught exception - the generic handler at the bottom of this file can no
// longer be the thing that decides what happens to a listen failure.
server.on('error', err => {
  log(`⛔ האב נכשל להאזין ב-${LOCAL_URL}: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, LOCAL_HOST, () => {
  log(`🌐 האב מאזין ב-${LOCAL_URL}`);

  // Same approach bot.js uses to open its own single-account page. Gated on
  // WA_LAUNCH_SILENT so a headless run (a spawned child sets this, and so
  // can an unattended hub launch) never pops a browser tab.
  if (process.env.WA_LAUNCH_SILENT !== '1') {
    const cmd = process.platform === 'darwin' ? `open "${LOCAL_URL}"`
              : process.platform === 'win32' ? `start "" "${LOCAL_URL}"`
              : `xdg-open "${LOCAL_URL}"`;
    exec(cmd, { shell: true });
  }

  // ---------- adopt a pre-existing single-account install ----------
  // Runs only once the port is actually ours - never before a bind is
  // confirmed, so a second "npm start" against an already-running hub can
  // never adopt a legacy install or spawn a duplicate bot onto its auth dir.
  if (hasLegacyInstall(INSTALL_DIR)) {
    try {
      const result = adoptLegacyInstall(INSTALL_DIR, 'main');
      if (result?.adopted) log('📦 זוהתה התקנה קיימת - הועברה אל accounts/main');
    } catch (e) {
      // Don't let a broken legacy state (e.g. accounts/main already exists
      // while a stray config.json also sits at the install root) take the
      // whole hub down before it can even start serving the other accounts.
      log('⚠️ העברת התקנה קיימת נכשלה, ממשיך ללא אימוץ:', e.message);
    }
  }

  for (const summary of getAccounts()) {
    if (summary.configured) {
      spawnChild(summary).catch(e => {
        const reason = `שגיאה בהפעלת "${summary.id}": ${e.message}`;
        log(`⚠️ ${reason}`);
        startupWarnings.push(reason);
      });
    } else if (fs.existsSync(path.join(summary.dir, 'config.json'))) {
      // configured is false but a config.json file exists - it failed to
      // parse. Say so instead of silently leaving the card as "stopped".
      const reason = `קובץ ההגדרות של "${summary.id}" פגום או לא קריא, מדלג על החשבון`;
      log(`⚠️ ${reason}`);
      startupWarnings.push(reason);
    }
  }
});

// ---------- graceful shutdown ----------
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('⏹️ סוגר את כל החשבונות...');
  await Promise.all([...children.keys()].map(id => stopChild(id)));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', e => {
  // A listen failure is handled by server.on('error') above and should
  // never reach here - but if some other bind attempt ever does surface one
  // this way, it must still stop the process instead of being logged and
  // silently carried on from, which is exactly how one hub run ended up
  // spawning children on top of a second, already-running hub.
  if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES' || e.code === 'EADDRNOTAVAIL')) {
    log(`⛔ האב נכשל להאזין ב-${LOCAL_URL}: ${e.message}`);
    process.exit(1);
  }
  log('uncaught:', e.message);
});
