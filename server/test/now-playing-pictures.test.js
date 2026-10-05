// "Now playing" gives a picture address only for a title in a library the app
// lists.
//
// A picture address is signed, and the picture route serves any address the
// app signed. The now-playing list signed the picture of whatever was playing,
// so while someone looked at a photo or played a track, a device that may only
// look could be handed that picture. The title of what is playing is still
// listed; only the picture address is held back.
//
// A stand-in Plex server on this computer and dummy data. Nothing leaves
// 127.0.0.1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = 'dummy-account-token';
process.env.DISABLE_MDNS = '1';

const SESSIONS = [
  { sessionKey: '1', type: 'movie', title: 'Dummy Film', librarySectionID: '1', thumb: '/library/metadata/11/thumb/1700000011' },
  { sessionKey: '2', type: 'photo', title: 'Dummy Photo', librarySectionID: '5', thumb: '/library/metadata/51/thumb/1700000051' },
  { sessionKey: '3', type: 'track', title: 'Dummy Track', thumb: '/library/metadata/61/thumb/1700000061' },
];

const standIn = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ MediaContainer: { Metadata: SESSIONS } }));
});
await new Promise((resolve) => standIn.listen(0, '127.0.0.1', resolve));
const uri = `http://127.0.0.1:${standIn.address().port}`;
after(() => standIn.close());

const { getActiveSessions } = await import('../src/plex-playback.js');
const { isIssuedPicture, readPictureAddress } = await import('../src/plex-images.js');

test('a film from a listed library keeps its picture; a photo or a track playing from an unlisted one gets none', async () => {
  const listed = (section) => String(section) === '1';
  const sessions = await getActiveSessions(uri, 'dummy-server-token', listed);
  assert.equal(sessions.length, 3, 'what is playing is still listed');

  const film = sessions.find((s) => s.title === 'Dummy Film');
  assert.ok(film.thumb.startsWith('/api/image?'));
  const address = readPictureAddress(film.thumb);
  assert.ok(isIssuedPicture(address.server, address.path, address.sig), 'the film address is one the app issued');

  assert.equal(sessions.find((s) => s.title === 'Dummy Photo').thumb, null);
  // An answer that names no section is treated as unlisted.
  assert.equal(sessions.find((s) => s.title === 'Dummy Track').thumb, null);
});
