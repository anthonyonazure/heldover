// What this app sends to a Plex server, and what it does with the answer.
//
// A listed Plex server is often someone else's machine. It used to be able to
// answer "go and ask over there", and the app went: to another machine on the
// home network, or to its own owner-only pages. And the token rode in the
// address, so an address that fetch refused came back to the browser inside
// the error text, token included. These checks pin both rules with stand-in
// servers on this computer: a request ends at the server it was sent to, and
// no address or error text holds a token.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = 'dummy-account-token';
process.env.DISABLE_MDNS = '1';
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';

const SHARE_TOKEN = 'dummy-share-token';
const open = [];

/** A stand-in machine on this computer that remembers what it was asked. */
function listen(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, token: req.headers['x-plex-token'] || null });
      handler(req, res);
    });
    open.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const json = (res, body) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
const sendAway = (res, to) => {
  res.writeHead(302, { Location: to });
  res.end();
};

// A machine that is on no list. Whatever reaches it should not have.
const elsewhere = await listen((req, res) => {
  if (req.url.startsWith('/private/camera.jpg')) {
    res.setHeader('Content-Type', 'image/jpeg');
    return res.end('PICTURE-FROM-ELSEWHERE');
  }
  json(res, { MediaContainer: { machineIdentifier: 'friend', allowSync: true, token: 'made-up', size: 9, Directory: [] } });
});

// A friend's Plex server that is on the list, and answers most things by
// pointing at the other machine.
const friend = await listen((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/identity') return json(res, { MediaContainer: { machineIdentifier: 'friend' } });
  if (url.pathname === '/photo/:/transcode' && (url.searchParams.get('url') || '').startsWith('/library/metadata/7/')) {
    res.setHeader('Content-Type', 'image/jpeg');
    return res.end('PICTURE-FROM-FRIEND');
  }
  if (url.pathname === '/photo/:/transcode' || url.pathname.endsWith('/thumb')) {
    return sendAway(res, `${elsewhere.base}/private/camera.jpg`);
  }
  sendAway(res, `${elsewhere.base}/collect`);
});

// An honest server: answers what it is asked. It lists one show library, and
// says that what it is asked about is in it.
const honest = await listen((req, res) =>
  json(res, { MediaContainer: { size: 2, librarySectionID: 2, Directory: [{ key: '2', type: 'show', title: 'Series' }], Metadata: [], Server: [] } })
);

// plex.tv is played by a stand-in: one shared server, at the friend's address.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://plex.tv/api/v2/resources')) {
    return new Response(
      JSON.stringify([
        {
          name: 'Friend server',
          provides: 'server',
          owned: false,
          presence: true,
          clientIdentifier: 'friend',
          accessToken: SHARE_TOKEN,
          connections: [{ uri: friend.base, local: false, protocol: 'http' }],
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return realFetch(input, init);
};

const { app } = await import('../src/app.js');
await import('../src/routes/servers-posters.js');
const { fetchFromServerWithFallback, checkServerHealth } = await import('../src/plex-connections.js');
const { getActiveSessions, getClients, getTransientToken, playMediaOnClient } = await import('../src/plex-playback.js');
const { identifiesAs } = await import('../src/plex-servers.js');
const { downloadsAllowedOn, forgetDownloadPermissions } = await import('../src/download-permission.js');
const { subscribe } = await import('../src/subscriptions.js');
const { proxiedImageUrl } = await import('../src/plex-images.js');

const listener = await new Promise((resolve) => {
  const l = app.listen(0, '127.0.0.1', () => resolve(l));
});
open.push(listener);
const appBase = `http://127.0.0.1:${listener.address().port}`;

after(() => {
  globalThis.fetch = realFetch;
  for (const server of open) server.close();
});

// The address the app itself issues for that poster, signature included: the
// picture route serves no other.
const poster = (server, imagePath) => realFetch(`${appBase}${proxiedImageUrl(server, imagePath)}`);
const reset = () => {
  elsewhere.seen.length = 0;
  friend.seen.length = 0;
  honest.seen.length = 0;
};

test('a listed server that answers a poster request with a redirect gives no picture, and the other machine hears nothing', async () => {
  reset();
  // The honest case first: the listed server's own picture comes through.
  const own = await poster(friend.base, '/library/metadata/7/thumb');
  assert.equal(own.status, 200);
  assert.equal(await own.text(), 'PICTURE-FROM-FRIEND');

  const redirected = await poster(friend.base, '/library/metadata/1/thumb');
  assert.equal(redirected.status, 404, 'no picture');
  assert.equal(elsewhere.seen.length, 0, 'the machine the redirect named received no request');
  // Both ways of asking were tried and both were refused, so nothing was kept:
  // asking again is still not a cache hit.
  const again = await poster(friend.base, '/library/metadata/1/thumb');
  assert.equal(again.status, 404);
  assert.equal(elsewhere.seen.length, 0);
});

test('a poster request carries the token as a header', async () => {
  reset();
  await poster(friend.base, '/library/metadata/8/thumb');
  const asked = friend.seen.filter((s) => s.url.startsWith('/photo/') || s.url.startsWith('/library/'));
  assert.ok(asked.length >= 1);
  for (const request of asked) {
    assert.equal(request.token, SHARE_TOKEN, 'the friend gets its own token, as a header');
    assert.equal(new URL(request.url, 'http://x').searchParams.has('X-Plex-Token'), false, request.url);
  }
});

test('a library read that is redirected away moves on to the next address', async () => {
  reset();
  // "https" only ranks the redirecting address first; both are plain stand-ins.
  const connections = [
    { uri: friend.base, local: false, protocol: 'https' },
    { uri: honest.base, local: false, protocol: 'http' },
  ];
  const res = await fetchFromServerWithFallback(connections, '/library/sections?type=1', SHARE_TOKEN, {
    headers: { Accept: 'application/json' },
  });
  assert.equal((await res.json()).MediaContainer.size, 2, 'the answer came from the next address');
  assert.equal(elsewhere.seen.length, 0, 'the machine the redirect named received no request');
  assert.deepEqual(honest.seen, [{ url: '/library/sections?type=1', token: SHARE_TOKEN }], 'token as a header, address untouched');

  // With no other address to try, the read fails with words and no address.
  await assert.rejects(fetchFromServerWithFallback([connections[0]], '/library/sections', SHARE_TOKEN), (err) => {
    assert.match(err.message, /redirect/i);
    assert.equal(err.message.includes('127.0.0.1'), false);
    return true;
  });
  assert.equal(elsewhere.seen.length, 0);
});

test('error text from a server read never holds a token, a query string or a sign-in', async () => {
  reset();
  const port = new URL(honest.base).port;
  const refused = [
    // Shapes fetch refuses before sending, quoting the whole address as it does.
    { uri: `http://someone:hunter2@127.0.0.1:${port}`, local: false, protocol: 'http' },
    { uri: 'http://127.0.0.1:99999', local: false, protocol: 'http' },
    { uri: '', local: false, protocol: 'http' },
  ];
  const safe = (text) => {
    for (const secret of ['made-up-server-token', 'X-Plex-Token', '?', 'hunter2', 'type=1']) {
      assert.equal(text.includes(secret), false, `"${secret}" in: ${text}`);
    }
  };
  for (const connection of refused) {
    await assert.rejects(
      fetchFromServerWithFallback([connection], '/library/sections/1/all?type=1', 'made-up-server-token'),
      (err) => {
        safe(err.message);
        safe(String(err.cause?.message || ''));
        return true;
      }
    );
  }
  // A token that cannot be sent as a header is quoted by fetch in its error.
  await assert.rejects(fetchFromServerWithFallback([{ uri: honest.base }], '/library/sections', 'made-up-server-token\nX'), (err) => {
    safe(err.message);
    return true;
  });
  assert.equal(honest.seen.length, 0);
});

test('health checks, sessions and players send the token as a header', async () => {
  reset();
  await checkServerHealth(honest.base, SHARE_TOKEN, [{ uri: honest.base, local: false, protocol: 'http' }]);
  await getActiveSessions(honest.base, SHARE_TOKEN);
  await getClients(honest.base, SHARE_TOKEN);
  assert.deepEqual(
    honest.seen,
    ['/identity', '/status/sessions', '/clients'].map((url) => ({ url, token: SHARE_TOKEN }))
  );
});

test('a redirect is never followed to another machine, whatever was being asked', async () => {
  reset();
  // Nothing is passed on, and each caller takes the redirect as "no".
  assert.deepEqual(await getActiveSessions(friend.base, SHARE_TOKEN), []);
  assert.deepEqual(await getClients(friend.base, SHARE_TOKEN), []);
  await assert.rejects(getTransientToken(friend.base, SHARE_TOKEN), /redirect/i);
  assert.equal(await identifiesAs(`${friend.base}/elsewhere`, 'friend'), false, 'a redirected answer proves nothing');
  forgetDownloadPermissions();
  assert.equal(
    await downloadsAllowedOn({ clientIdentifier: 'friend', uri: friend.base, owned: false }, SHARE_TOKEN),
    false,
    'a yes from another machine is not the owner saying yes'
  );
  assert.equal(elsewhere.seen.length, 0, 'the machine the redirects named received no request and no token');
});

test('subscribing asks the server with the token as a header and stops at a redirect', async () => {
  reset();
  const servers = [
    { clientIdentifier: 'friend', uri: friend.base, accessToken: SHARE_TOKEN },
    { clientIdentifier: 'honest', uri: honest.base, accessToken: SHARE_TOKEN },
  ];
  const redirected = await subscribe({ title: 'Show A', plex_key: '11', server_key: 'friend' }, servers, 'unused');
  assert.equal(redirected.last_known_episodes, 0, 'the other machine said 9 and was not heard');
  assert.equal(elsewhere.seen.length, 0);

  const counted = await subscribe({ title: 'Show B', plex_key: '12', server_key: 'honest' }, servers, 'unused');
  assert.equal(counted.last_known_episodes, 2);
  // The show is read once. The second request is the app reading the server's
  // list of libraries, to check that the show is in one of them.
  assert.deepEqual(honest.seen, [
    { url: '/library/metadata/12/allLeaves', token: SHARE_TOKEN },
    { url: '/library/sections', token: SHARE_TOKEN },
  ]);
});

test('a play command that cannot be sent never repeats its address, which holds a token', async () => {
  const stubbed = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new TypeError(`Failed to parse URL from ${url}`);
  };
  try {
    await assert.rejects(
      playMediaOnClient({
        client: { address: '192.168.1.50', port: 32500, machineIdentifier: 'player' },
        serverIdentifier: 'friend',
        serverAddress: 'friend.example',
        serverPort: 32400,
        ratingKey: '5',
        token: 'made-up-short-lived-token',
      }),
      (err) => {
        assert.equal(err.message.includes('made-up-short-lived-token'), false, err.message);
        assert.equal(err.message.includes('X-Plex-Token'), false, err.message);
        assert.equal(err.cause, undefined, 'the original error is not carried along');
        return true;
      }
    );
  } finally {
    globalThis.fetch = stubbed;
  }
});
