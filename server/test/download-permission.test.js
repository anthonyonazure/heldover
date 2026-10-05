// Downloads from a shared server follow its owner's "Allow Downloads" switch.
// None of the servers this was developed against had the switch off, so the
// "no" answers are exercised here with stand-in Plex replies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsDownloads, downloadsAllowedOn, forgetDownloadPermissions } from '../src/download-permission.js';

const reply = (container, ok = true) => async () => ({ ok, json: async () => ({ MediaContainer: container }) });
const shared = { clientIdentifier: 'friend', uri: 'https://friend.example:32400', owned: false };

test('only an explicit yes counts', () => {
  for (const yes of [true, 1, '1']) assert.equal(allowsDownloads({ allowSync: yes }), true, String(yes));
  for (const no of [false, 0, '0', undefined, null, 'true']) assert.equal(allowsDownloads({ allowSync: no }), false, String(no));
  assert.equal(allowsDownloads(undefined), false);
});

test('your own server never needs asking', async () => {
  let asked = false;
  const allowed = await downloadsAllowedOn({ ...shared, owned: true }, 't', async () => { asked = true; });
  assert.equal(allowed, true);
  assert.equal(asked, false);
});

test('a shared server is asked, with its own token, and its answer is kept for a while', async () => {
  forgetDownloadPermissions();
  const seen = [];
  const yes = async (url, options) => {
    seen.push([url, options.headers['X-Plex-Token']]);
    return { ok: true, json: async () => ({ MediaContainer: { allowSync: true } }) };
  };
  assert.equal(await downloadsAllowedOn(shared, 'share-token', yes), true);
  assert.equal(await downloadsAllowedOn(shared, 'share-token', reply({ allowSync: false })), true, 'remembered');
  assert.deepEqual(seen, [['https://friend.example:32400/', 'share-token']]);
});

test('no, no answer, an error reply and an unreachable server all mean no', async () => {
  forgetDownloadPermissions();
  assert.equal(await downloadsAllowedOn(shared, 't', reply({ allowSync: false })), false);
  forgetDownloadPermissions();
  assert.equal(await downloadsAllowedOn(shared, 't', reply({})), false);
  forgetDownloadPermissions();
  assert.equal(await downloadsAllowedOn(shared, 't', reply({ allowSync: true }, false)), false);
  forgetDownloadPermissions();
  const down = async () => { throw new Error('fetch failed'); };
  assert.equal(await downloadsAllowedOn(shared, 't', down), false);
  // Being unreachable is not remembered: the next try asks again.
  assert.equal(await downloadsAllowedOn(shared, 't', reply({ allowSync: true })), true);
});
