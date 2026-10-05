// A Plex server (often someone else's) names the addresses this app then
// fetches with a token. These checks pin the rule: the request stays on the
// server it was meant for, whatever the server says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { OffOriginError, plexFetch, sameOriginUrl } from '../src/plex-fetch.js';

function listen(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, token: req.headers['x-plex-token'] || null });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('an address must be on the server it was given for', () => {
  const base = 'https://friend.example:32400';
  assert.equal(sameOriginUrl(base, '/library/parts/7/file.mkv'), 'https://friend.example:32400/library/parts/7/file.mkv');
  assert.equal(sameOriginUrl(base, 'https://friend.example:32400/x'), 'https://friend.example:32400/x');
  // "@host/" is only a path on the same server once it is resolved properly.
  assert.equal(new URL(sameOriginUrl(base, '/@other.example/x')).origin, 'https://friend.example:32400');
  for (const away of ['http://127.0.0.1:3001/api/setup/status', 'https://other.example/x', '//other.example/x', 'http://friend.example:32400/x', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.throws(() => sameOriginUrl(base, away), OffOriginError, away);
  }
  assert.throws(() => sameOriginUrl('not an address', '/x'), OffOriginError);
});

test('a refusal never repeats the address, which can carry a token', () => {
  try {
    sameOriginUrl('https://friend.example:32400', 'https://other.example/x?X-Plex-Token=secret-token');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.message.includes('secret-token'), false);
    assert.equal(err.message.includes('other.example'), false);
  }
});

test('a redirect to another machine is refused and that machine hears nothing', async () => {
  const other = await listen((req, res) => res.end('should never be asked'));
  const plex = await listen((req, res) => {
    res.writeHead(302, { Location: `${other.base}/api/setup/status` });
    res.end();
  });
  try {
    await assert.rejects(plexFetch(`${plex.base}/photo`, { headers: { 'X-Plex-Token': 'dummy-token' } }), OffOriginError);
    assert.equal(other.seen.length, 0, 'the other machine received no request and no token');
    assert.equal(plex.seen.length, 1);
  } finally {
    plex.server.close();
    other.server.close();
  }
});

test('a redirect that stays on the same server is followed, a few times at most', async () => {
  const plex = await listen((req, res) => {
    if (req.url === '/old') { res.writeHead(301, { Location: '/new' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    res.end('picture');
  });
  try {
    const res = await plexFetch(`${plex.base}/old`, { headers: { 'X-Plex-Token': 'dummy-token' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'picture');
    assert.deepEqual(plex.seen.map((s) => s.url), ['/old', '/new']);
    await assert.rejects(plexFetch(`${plex.base}/loop`), OffOriginError);
  } finally {
    plex.server.close();
  }
});

test('a request that changes something is never redirected, and the caller cannot switch following back on', async () => {
  const plex = await listen((req, res) => {
    res.writeHead(307, { Location: '/elsewhere' });
    res.end();
  });
  try {
    await assert.rejects(plexFetch(`${plex.base}/act`, { method: 'POST', body: 'x' }), OffOriginError);
    assert.equal(plex.seen.length, 1);
    const calls = [];
    const spy = async (url, options) => { calls.push(options.redirect); return new Response('ok'); };
    await plexFetch('http://127.0.0.1:1/x', { redirect: 'follow' }, spy);
    assert.deepEqual(calls, ['manual']);
  } finally {
    plex.server.close();
  }
});
