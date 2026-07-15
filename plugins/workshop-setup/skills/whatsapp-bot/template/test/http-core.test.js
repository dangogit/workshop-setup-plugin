import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { persistThenApply, readBody, requestAccessError } from '../lib/http-core.js';

const TOKEN = 'test-token';

function request(port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('local HTTP guard rejects rebinding, bad origins, missing tokens, and oversized bodies', async t => {
  let liveConfig = { mode: 'old' };
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const denied = requestAccessError(req, { expectedToken: TOKEN, port });
    if (denied) {
      res.writeHead(denied.status);
      return res.end(denied.code);
    }
    try {
      if (req.method === 'POST') {
        const raw = await readBody(req, 32);
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) {
          res.writeHead(400);
          return res.end('invalid_json');
        }
        persistThenApply(parsed, {
          persist: value => { if (value.fail) throw new Error('disk_failed'); },
          apply: value => { liveConfig = value; },
        });
      }
      res.writeHead(200);
      res.end('ok');
    } catch (error) {
      res.writeHead(error.statusCode || 500);
      res.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const mutationHeaders = {
    Host: host,
    Origin: `http://${host}`,
    'X-WA-Bot-Token': TOKEN,
    'Content-Type': 'application/json',
  };

  assert.equal((await request(port, { headers: { Host: host } })).status, 200);
  assert.equal((await request(port, { headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request(port, { method: 'POST', headers: { Host: host }, body: '{}' })).status, 403);
  assert.equal((await request(port, {
    method: 'POST',
    headers: { ...mutationHeaders, Origin: 'https://evil.example' },
    body: '{}',
  })).status, 403);
  assert.equal((await request(port, { method: 'POST', headers: mutationHeaders, body: '{' })).status, 400);
  assert.equal((await request(port, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'x'.repeat(40) }) })).status, 413);

  const failed = await request(port, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ fail: true }) });
  assert.equal(failed.status, 500);
  assert.deepEqual(liveConfig, { mode: 'old' });

  const saved = await request(port, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ mode: 'new' }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(liveConfig, { mode: 'new' });
});
