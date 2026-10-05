// A download is fetched from the Plex server the title lives on, and from
// nowhere else.
//
// A shared server is someone else's machine. It names the address of each
// file itself, and it can answer any request with a redirect. Both used to be
// followed: the app fetched whatever address came back, with that server's
// token and the device's Range header, and passed the answer on to the device.
//
// Two stand-in servers on this computer's loopback: "plex" plays the shared
// server and "other" plays a machine that must never be asked anything. Only
// plex.tv is faked inside the process. Dummy tokens, throwaway data folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = 'dummy-account-token';
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
delete process.env.TRUST_PROXY;

const SHARE_TOKEN = 'dummy-share-token';
const FILE_BYTES = '0123456789';

function listen(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, token: req.headers['x-plex-token'] || null, range: req.headers.range || null });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// The machine that must hear nothing: a router page, a NAS, another app.
const other = await listen((req, res) => res.end('INTERNAL-SECRET-RESPONSE'));

// The shared Plex server. What it says about each title can be changed
// between requests, as its operator could.
const partKeys = new Map();
const says = { frontPage: 'answer', metadata: 'answer' };
const sendJson = (res, container) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ MediaContainer: { machineIdentifier: 'friend-id', allowSync: true, ...container } }));
};
const sendElsewhere = (res, where) => {
  res.writeHead(302, { Location: where });
  res.end();
};

const plex = await listen((req, res) => {
  const { pathname } = new URL(req.url, 'http://plex');
  if (pathname === '/') {
    if (says.frontPage === 'redirect') return sendElsewhere(res, `${other.base}/`);
    return sendJson(res, {});
  }
  if (pathname === '/identity') return sendJson(res, {});
  // One movie library, and every title below says it is in it: the app makes
  // links only for titles from the libraries a server lists.
  if (pathname === '/library/sections') return sendJson(res, { Directory: [{ key: '1', type: 'movie', title: 'Films' }] });
  const title = pathname.match(/^\/library\/metadata\/(\d+)$/);
  if (title) {
    if (says.metadata === 'redirect') return sendElsewhere(res, `${other.base}${pathname}`);
    return sendJson(res, {
      Metadata: [
        {
          title: `Dummy Film ${title[1]}`,
          year: 2020,
          librarySectionID: 1,
          Media: [{ videoResolution: '1080', Part: [{ key: partKeys.get(title[1]), file: '/media/Dummy Film.mkv', size: FILE_BYTES.length }] }],
        },
      ],
    });
  }
  if (pathname === '/library/parts/redirect-away/file.mkv') return sendElsewhere(res, `${other.base}/internal/secret`);
  if (pathname === '/library/parts/moved/file.mkv') return sendElsewhere(res, '/library/parts/good/file.mkv');
  if (pathname === '/library/parts/good/file.mkv') {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      res.writeHead(206, {
        'content-type': 'video/x-matroska',
        'content-range': `bytes ${from}-${to}/${FILE_BYTES.length}`,
        'content-length': to - from + 1,
        'accept-ranges': 'bytes',
      });
      return res.end(FILE_BYTES.slice(from, to + 1));
    }
    res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': FILE_BYTES.length, 'accept-ranges': 'bytes' });
    return res.end(FILE_BYTES);
  }
  res.writeHead(404);
  res.end();
});

// plex.tv lists that one server as shared with this account, at the address
// the server itself registered. Everything else goes out for real, which here
// means to the two stand-ins and to the app under test.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const address = String(typeof input === 'string' ? input : input?.href || input?.url || input);
  if (address.startsWith('https://plex.tv/')) {
    return Promise.resolve(
      new Response(
        JSON.stringify([
          {
            name: 'Friend',
            provides: 'server',
            clientIdentifier: 'friend-id',
            owned: false,
            presence: true,
            accessToken: SHARE_TOKEN,
            connections: [{ uri: plex.base, local: false, protocol: 'http' }],
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
  }
  return realFetch(input, options);
};

// Imported only after DATA_DIR is set: the database opens on import.
const config = await import('../src/config.js');
const { app } = await import('../src/app.js');
const { forgetDownloadPermissions } = await import('../src/download-permission.js');
await import('../src/routes/downloads.js');
config.updateConfig({ downloadsEnabled: true });

const listener = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const appBase = `http://127.0.0.1:${listener.address().port}`;
after(() => {
  listener.close();
  plex.server.close();
  other.server.close();
});

// Asked from this computer with no forwarding header: the owner, who may download.
async function ask(address, headers = {}) {
  const res = await realFetch(`${appBase}${address}`, { headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* a file, not JSON */ }
  return { status: res.status, headers: res.headers, text, body };
}

/** A link for a title, made while the server still names an ordinary address. */
async function linkFor(ratingKey) {
  partKeys.set(ratingKey, '/library/parts/good/file.mkv');
  const made = await ask(`/api/download-url/friend-id/${ratingKey}`);
  assert.equal(made.status, 200);
  assert.equal(made.body.downloads.length, 1);
  return made.body.downloads[0].url;
}

function assertPlainRefusal(answer, what) {
  assert.equal(answer.status, 502, what);
  assert.match(answer.body.error, /different address/, what);
  // The message names no address: not the one refused, not the server's.
  assert.doesNotMatch(answer.text, /127\.0\.0\.1|https?:|\/\/|internal|meta|dummy/, what);
  assert.doesNotMatch(answer.text, /INTERNAL-SECRET-RESPONSE/, what);
}

test('a file on the server itself still downloads, whole or in ranges, with the server\'s own token', async () => {
  const link = await linkFor('40');
  const whole = await ask(link);
  assert.equal(whole.status, 200);
  assert.equal(whole.text, FILE_BYTES);
  assert.match(whole.headers.get('content-disposition'), /filename="Dummy Film\.mkv"/);

  const piece = await ask(link, { Range: 'bytes=2-5' });
  assert.equal(piece.status, 206);
  assert.equal(piece.text, '2345');
  assert.equal(piece.headers.get('content-range'), `bytes 2-5/${FILE_BYTES.length}`);
  assert.equal(piece.headers.get('accept-ranges'), 'bytes');

  const fileRequests = plex.seen.filter((r) => r.url === '/library/parts/good/file.mkv');
  assert.deepEqual(fileRequests, [
    { url: '/library/parts/good/file.mkv', token: SHARE_TOKEN, range: null },
    { url: '/library/parts/good/file.mkv', token: SHARE_TOKEN, range: 'bytes=2-5' },
  ]);
  // The token travels in a header, never in the address.
  assert.equal(plex.seen.some((r) => r.url.startsWith('/library/') && r.url.includes('X-Plex-Token')), false);
  assert.equal(other.seen.length, 0);
});

test('a redirect that stays on the server is followed, and the range goes with it', async () => {
  partKeys.set('41', '/library/parts/moved/file.mkv');
  const made = await ask('/api/download-url/friend-id/41');
  assert.equal(made.status, 200);
  const piece = await ask(made.body.downloads[0].url, { Range: 'bytes=0-3' });
  assert.equal(piece.status, 206);
  assert.equal(piece.text, '0123');
  assert.equal(other.seen.length, 0);
});

for (const [name, awayKey] of [
  ['a full address on another machine', () => `${other.base}/latest/meta-data/`],
  ['an address that starts with two slashes', () => `//${new URL(other.base).host}/meta`],
]) {
  test(`${name} as the file's address: no link is made, a link made earlier is stopped, and the other machine hears nothing`, async () => {
    const ratingKey = name.startsWith('a full') ? '10' : '20';
    // The server names an ordinary address while the link is made, then changes its answer.
    const link = await linkFor(ratingKey);
    partKeys.set(ratingKey, awayKey());

    assertPlainRefusal(await ask(link, { Range: 'bytes=0-1023' }), 'the link made earlier');
    const again = await ask(`/api/download-url/friend-id/${ratingKey}`);
    assertPlainRefusal(again, 'a new link');
    assert.equal(again.body.downloads, undefined);
    assert.equal(other.seen.length, 0, 'the other machine received no request and no token');
  });
}

test('a file address on the server that redirects to another machine is stopped, and the other machine hears nothing', async () => {
  partKeys.set('30', '/library/parts/redirect-away/file.mkv');
  const made = await ask('/api/download-url/friend-id/30');
  assert.equal(made.status, 200, 'the address itself is on the server, so a link is made');
  assertPlainRefusal(await ask(made.body.downloads[0].url, { Range: 'bytes=0-1023' }), 'the download');
  assert.equal(plex.seen.filter((r) => r.url === '/library/parts/redirect-away/file.mkv').length, 1);
  assert.equal(other.seen.length, 0, 'the other machine received no request and no token');
});

test('the server\'s other answers cannot send a request elsewhere either', async () => {
  const link = await linkFor('50');

  // The read of the title's details, on both routes.
  says.metadata = 'redirect';
  try {
    assertPlainRefusal(await ask('/api/download-url/friend-id/50'), 'a new link');
    assertPlainRefusal(await ask(link), 'the link made earlier');
  } finally {
    says.metadata = 'answer';
  }

  // The question "does the owner allow downloads": no answer counts as no.
  says.frontPage = 'redirect';
  forgetDownloadPermissions();
  try {
    for (const address of ['/api/download-url/friend-id/50', link]) {
      const refused = await ask(address);
      assert.equal(refused.status, 403, address.split('?')[0]);
      assert.equal(refused.body.downloadsNotAllowed, true);
    }
  } finally {
    says.frontPage = 'answer';
    forgetDownloadPermissions();
  }
  assert.equal(other.seen.length, 0, 'the other machine received no request and no token');
});
