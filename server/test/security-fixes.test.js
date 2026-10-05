// The 2026-09-26 security review fixes: keys kept out of error text, owner
// status decided by the real connection, players reached only on the home
// network, and Plex ids checked before they go into a Plex address.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
delete process.env.PLEX_TOKEN;

const { isLocal } = await import('../src/auth.js');
const { plexId } = await import('../src/plex-ids.js');
const { isHomeNetworkAddress } = await import('../src/plex.js');
const lists = await import('../src/external-lists.js');

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('a forged X-Forwarded-For never makes a network device the owner', () => {
  assert.equal(isLocal(req('192.168.1.44', { 'x-forwarded-for': '127.0.0.1' })), false);
  assert.equal(isLocal(req('192.168.1.44')), false);
});

test('this computer is the owner, directly or through a proxy on itself', () => {
  assert.equal(isLocal(req('127.0.0.1')), true);
  assert.equal(isLocal(req('::1', { 'x-forwarded-for': '127.0.0.1' })), true);
});

test('a visitor arriving through a proxy on this computer is not the owner', () => {
  assert.equal(isLocal(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 192.168.1.44' })), false);
  assert.equal(isLocal(req('127.0.0.1', { forwarded: 'for=192.168.1.44' })), false);
});

test('Plex ids must be whole numbers', () => {
  assert.equal(plexId('42'), '42');
  assert.equal(plexId(7), '7');
  for (const bad of ['1/../../:/scrobble?x=', '1%2F..', '', 'abc', '-1', '1.5', null]) {
    assert.throws(() => plexId(bad), /Not a valid Plex/);
  }
});

test('players are only reached at private home-network addresses', () => {
  for (const ok of ['192.168.1.50', '10.0.0.2', '172.16.0.9', '172.31.255.1']) assert.equal(isHomeNetworkAddress(ok), true, ok);
  for (const bad of ['127.0.0.1', '169.254.1.1', '8.8.8.8', '172.32.0.1', '192.168.1.300', 'evil.example', '']) {
    assert.equal(isHomeNetworkAddress(bad), false, bad);
  }
});

test('an unknown list id does not echo the API key back', async () => {
  process.env.TMDB_API_KEY = 'SECRETKEY1234567890'; // gitleaks:allow (made up for this test)
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 404, statusText: 'Not Found' });
  try {
    await assert.rejects(lists.getTmdbCustomListItems('0'), (err) => {
      assert.doesNotMatch(err.message, /SECRETKEY/);
      assert.match(err.message, /404/);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TMDB_API_KEY;
  }
});

test('a token is only ever sent to a local address that has said it is that server', async () => {
  const { trustedConnections, identifiesAs } = await import('../src/plex-servers.js');
  delete process.env.PLEX_ALLOW_HTTP;
  // Local addresses as plex.tv lists them when asked for https: a plex.direct
  // name that stands for the home-network address. (Made-up names.)
  const connections = [
    { uri: 'https://remote.example:32400', local: false, protocol: 'https' },
    { uri: 'https://192-168-1-20.abc123.plex.direct:32400', local: true, protocol: 'https' },
    { uri: 'https://172-17-0-2.abc123.plex.direct:32400', local: true, protocol: 'https' },
  ];
  const asked = [];
  // The machine at 192.168.1.20 is the server; whatever sits at 172.17.0.2 is not.
  const network = async (url, options) => {
    asked.push(url);
    assert.equal(url.includes('X-Plex-Token'), false, 'no token in the question');
    assert.equal(options.headers['X-Plex-Token'], undefined, 'no token in the question');
    if (url.startsWith('https://192-168-1-20.')) return { ok: true, json: async () => ({ MediaContainer: { machineIdentifier: 'mine' } }) };
    return { ok: true, json: async () => ({ MediaContainer: { machineIdentifier: 'someone-else' } }) };
  };

  const shared = await trustedConnections({ owned: false, clientIdentifier: 'friend', connections }, network);
  assert.deepEqual(shared.map((c) => c.uri), ['https://remote.example:32400'], 'a shared server never keeps local addresses');
  assert.equal(asked.length, 0, 'and they are not even contacted');

  const owned = await trustedConnections({ owned: true, clientIdentifier: 'mine', connections }, network);
  assert.deepEqual(owned.map((c) => c.uri), ['https://remote.example:32400', 'https://192-168-1-20.abc123.plex.direct:32400']);

  const down = async () => { throw new Error('fetch failed'); };
  assert.equal(await identifiesAs('https://192-168-1-20.abc123.plex.direct:32400', 'mine', down), false);
  assert.equal(await identifiesAs('https://192-168-1-20.abc123.plex.direct:32400', '', network), false);
});
