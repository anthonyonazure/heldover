// A Plex token is only sent over https.
//
// The app used to decide that a home-network address was the owner's Plex
// server by asking it "who are you?" and accepting the server's name as the
// answer. That name is public: a Plex server tells it to anyone, and this app
// lists it. So a laptop that took the address of a server that was switched
// off could repeat the name and be sent the token, again every five minutes.
// Over https the server's certificate is the proof, so plain http addresses
// are now left out for every server (your own and shared ones) unless the
// owner sets PLEX_ALLOW_HTTP=1. Stand-in servers on this computer only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const ACCOUNT_TOKEN = 'dummy-account-token';
const OWNED_TOKEN = 'dummy-owned-server-token';
const SHARE_TOKEN = 'dummy-share-token';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = ACCOUNT_TOKEN;
process.env.DISABLE_MDNS = '1';
delete process.env.PLEX_ALLOW_HTTP;

const open = [];
function listen(machineIdentifier) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, token: req.headers['x-plex-token'] || null });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ MediaContainer: { machineIdentifier } }));
    });
    open.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Whatever holds the home-network address of the owner's server. It repeats
// the server's public name, which is all the old check asked for.
const impostor = await listen('mine');
// A friend's server that is only listed at a plain http address.
const friendHttp = await listen('friend');
// An address from an old server list.
const stale = await listen('mine');

const HTTPS_MINE = 'https://mine.example:32400';

// plex.tv and the one https address are played inside this process, so no
// certificate and no outside network is needed.
const plexTv = [];
const httpsSeen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const token = init?.headers?.['X-Plex-Token'] || null;
  if (url.startsWith('https://plex.tv/api/v2/resources')) {
    plexTv.push({ url, token });
    return new Response(
      JSON.stringify([
        {
          name: 'Home server',
          provides: 'server',
          owned: true,
          presence: true,
          clientIdentifier: 'mine',
          accessToken: OWNED_TOKEN,
          connections: [
            { uri: HTTPS_MINE, local: false, protocol: 'https' },
            { uri: impostor.base, local: true, protocol: 'http' },
          ],
        },
        {
          name: 'Friend server',
          provides: 'server',
          owned: false,
          presence: true,
          clientIdentifier: 'friend',
          accessToken: SHARE_TOKEN,
          connections: [{ uri: friendHttp.base, local: false, protocol: 'http' }],
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.startsWith(`${HTTPS_MINE}/`)) {
    httpsSeen.push({ url, token });
    return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'mine' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

const { trustedConnections, getServers } = await import('../src/plex-servers.js');
const { checkAllServers } = await import('../src/monitor.js');

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.PLEX_ALLOW_HTTP;
  for (const server of open) server.close();
});

test('only https addresses are kept, judged by the address and not by the label next to it', async () => {
  delete process.env.PLEX_ALLOW_HTTP;
  const connections = [
    { uri: 'https://remote.example:32400', local: false, protocol: 'https' },
    // The label says https, the address does not: the address is what counts.
    { uri: 'http://203.0.113.9:32400', local: false, protocol: 'https' },
    { uri: 'http://192.168.1.20:32400', local: true, protocol: 'http' },
    // And the other way round: an https address with an http label is fine.
    { uri: 'https://192-168-1-20.abc123.plex.direct:32400', local: true, protocol: 'http' },
    { uri: 'ftp://192.168.1.20', local: false, protocol: 'https' },
    { local: false, protocol: 'https' },
  ];
  const asked = [];
  const everyoneSaysMine = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => ({ MediaContainer: { machineIdentifier: 'mine' } }) };
  };

  const owned = await trustedConnections({ owned: true, clientIdentifier: 'mine', connections }, everyoneSaysMine);
  assert.deepEqual(
    owned.map((c) => [c.uri, c.protocol]),
    [
      ['https://remote.example:32400', 'https'],
      ['https://192-168-1-20.abc123.plex.direct:32400', 'https'],
    ]
  );
  assert.deepEqual(asked, ['https://192-168-1-20.abc123.plex.direct:32400/identity'], 'a plain http address is not even asked who it is');

  const shared = await trustedConnections({ owned: false, clientIdentifier: 'friend', connections }, everyoneSaysMine);
  assert.deepEqual(shared.map((c) => c.uri), ['https://remote.example:32400']);
});

test('the owner can opt in to plain http, and a local address must still say it is that server', async () => {
  const connections = [
    { uri: 'http://203.0.113.9:32400', local: false, protocol: 'http' },
    { uri: 'http://192.168.1.20:32400', local: true, protocol: 'http' },
    { uri: 'http://172.17.0.2:32400', local: true, protocol: 'http' },
  ];
  const network = async (url) => ({
    ok: true,
    json: async () => ({ MediaContainer: { machineIdentifier: url.startsWith('http://192.168.1.20') ? 'mine' : 'someone-else' } }),
  });
  try {
    for (const yes of ['1', 'true', ' YES ', 'on']) {
      process.env.PLEX_ALLOW_HTTP = yes;
      const owned = await trustedConnections({ owned: true, clientIdentifier: 'mine', connections }, network);
      assert.deepEqual(owned.map((c) => c.uri), ['http://203.0.113.9:32400', 'http://192.168.1.20:32400'], yes);
    }
    process.env.PLEX_ALLOW_HTTP = '1';
    const shared = await trustedConnections({ owned: false, clientIdentifier: 'friend', connections }, network);
    assert.deepEqual(shared.map((c) => c.uri), ['http://203.0.113.9:32400'], 'a shared server still never keeps local addresses');
    for (const no of ['0', 'false', '', 'maybe']) {
      process.env.PLEX_ALLOW_HTTP = no;
      assert.deepEqual(await trustedConnections({ owned: true, clientIdentifier: 'mine', connections }, network), [], no);
    }
  } finally {
    delete process.env.PLEX_ALLOW_HTTP;
  }
});

test('a machine that repeats the server name at a plain http address is sent nothing', async () => {
  delete process.env.PLEX_ALLOW_HTTP;
  const servers = await getServers(ACCOUNT_TOKEN);

  assert.equal(impostor.seen.length, 0, 'the plain http home-network address got no question and no token');
  assert.equal(friendHttp.seen.length, 0, 'a shared server at a plain http address got no token either');
  assert.deepEqual(
    servers.map((s) => [s.clientIdentifier, s.uri, s.connections.map((c) => c.uri)]),
    [['mine', HTTPS_MINE, [HTTPS_MINE]]],
    'only the https address is kept, and a server with none is left out'
  );
  assert.deepEqual(httpsSeen, [{ url: `${HTTPS_MINE}/identity`, token: OWNED_TOKEN }], 'the https address is sent the token, as a header');

  // What was asked of plex.tv: the https addresses, with the token as a header.
  const asked = new URL(plexTv.at(-1).url);
  assert.equal(asked.searchParams.get('includeHttps'), '1');
  assert.equal(asked.searchParams.has('X-Plex-Token'), false);
  assert.equal(plexTv.at(-1).token, ACCOUNT_TOKEN);
});

test('the health check works from a fresh server list, not from the one it is handed', async () => {
  delete process.env.PLEX_ALLOW_HTTP;
  const handed = [
    {
      name: 'Home server',
      clientIdentifier: 'mine',
      uri: stale.base,
      accessToken: OWNED_TOKEN,
      connections: [{ uri: stale.base, local: true, protocol: 'http' }],
    },
  ];
  httpsSeen.length = 0;
  const discoveries = plexTv.length;

  const results = await checkAllServers(handed, ACCOUNT_TOKEN);

  assert.equal(plexTv.length, discoveries + 1, 'the server list was discovered again first');
  assert.equal(stale.seen.length, 0, 'the address from the old list got no token');
  assert.deepEqual(results.map((r) => [r.serverKey, r.serverUri, r.online]), [['mine', HTTPS_MINE, true]]);
  assert.ok(httpsSeen.length >= 2, 'the fresh https address was probed');
  assert.ok(httpsSeen.every((s) => s.token === OWNED_TOKEN));

  // Only when no list can be had at all is the caller's own list used.
  const noList = async () => {
    throw new Error('PLEX_TOKEN not configured');
  };
  await checkAllServers(handed, ACCOUNT_TOKEN, noList);
  assert.deepEqual(stale.seen, [{ url: '/identity', token: OWNED_TOKEN }]);
});

test('with PLEX_ALLOW_HTTP=1 plain http addresses are used again, token as a header', async () => {
  process.env.PLEX_ALLOW_HTTP = '1';
  try {
    impostor.seen.length = 0;
    friendHttp.seen.length = 0;
    const servers = await getServers(ACCOUNT_TOKEN);
    assert.deepEqual(servers.map((s) => s.clientIdentifier), ['mine', 'friend']);
    assert.deepEqual(
      impostor.seen,
      [
        { url: '/identity', token: null },
        { url: '/identity', token: OWNED_TOKEN },
      ],
      'asked who it is without a token first, then probed with one'
    );
    assert.deepEqual(friendHttp.seen, [{ url: '/identity', token: SHARE_TOKEN }]);
  } finally {
    delete process.env.PLEX_ALLOW_HTTP;
  }
});
