// "Re-check" (POST /api/status/check) sends a probe to every connection of
// every Plex server, and any device that may look can ask for it. Each request
// used to run a round of probes of its own, with no limit, and each round that
// met a failing server added its own strike to the shared backoff: eight
// requests sent together turned a 30 second pause into a one hour removal of
// that server for everyone.
//
// These checks pin the rules that replaced that: requests that arrive
// together share one round, a request soon after a round gets that round's
// answer at once, and one outage is one strike however many requests saw it.
// Runs against a throwaway data folder and stand-in servers on this computer.

import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { DUMMY_TOKEN, listenForTest, stubPlexTv } from './helpers/stand-in-plex.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = DUMMY_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

// How long a stand-in holds each answer. A failing answer that takes a while
// is what let every request of a burst set out before the first one came back.
const ANSWER_DELAY_MS = 40;

/**
 * A stand-in Plex server that answers the probe (/identity) and nothing else.
 * `answer` is the status it gives; `probes` counts the probes it was sent.
 * Listed by plex.tv as a server shared with the account at a public address,
 * so it stays on the server list while it is failing.
 */
async function startProbeTarget(serverKey) {
  const target = { serverKey, answer: 200, probes: 0 };
  const server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://stand-in').pathname === '/identity') target.probes += 1;
    setTimeout(() => {
      res.writeHead(target.answer, { 'content-type': 'application/json' });
      res.end(JSON.stringify(target.answer === 200 ? { MediaContainer: { machineIdentifier: serverKey } } : { error: 'dummy failure' }));
    }, ANSWER_DELAY_MS);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  target.uri = `http://127.0.0.1:${server.address().port}`;
  target.resource = () => ({
    name: `Stand-in ${serverKey}`,
    provides: 'server',
    owned: false,
    presence: true,
    clientIdentifier: serverKey,
    accessToken: DUMMY_TOKEN,
    connections: [{ uri: target.uri, local: false, protocol: 'http' }],
  });
  target.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return target;
}

const healthy = await startProbeTarget('stand-in-healthy');
const failing = await startProbeTarget('stand-in-failing');
const refusing = await startProbeTarget('stand-in-refusing');
const targets = [healthy, failing, refusing];
const refused = stubPlexTv(targets);

const { app, ensureServers } = await import('../src/app.js');
await import('../src/routes/monitoring.js');
const backoff = await import('../src/server-backoff.js');
const { call, close } = await listenForTest(app);

after(async () => {
  mock.timers.reset();
  await close();
  await Promise.all(targets.map((target) => target.stop()));
});

// The clock stands still unless a test moves it, so "within the interval" and
// "after the pause has run out" do not depend on how fast this computer is.
// Only the clock: timers and the network run as they are.
mock.timers.enable({ apis: ['Date'], now: Date.now() });
const later = (seconds) => mock.timers.tick(seconds * 1000);

/** A re-check from a device that may only look. */
const recheck = () => call('POST', '/api/status/check', { lookOnly: true });
/**
 * Find the servers again and forget the probes that took, so what a test
 * counts afterwards is only what its own re-checks sent.
 */
async function freshList() {
  await ensureServers(true);
  for (const target of targets) target.probes = 0;
}
const onlineBy = (statuses) => Object.fromEntries(statuses.map((s) => [s.serverKey, s.online]));

test('re-checks that arrive together share one round of probes, and all get its answer', async () => {
  later(60);
  await freshList();
  const answers = await Promise.all(Array.from({ length: 5 }, recheck));

  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200]);
  assert.deepEqual(targets.map((t) => t.probes), [1, 1, 1], 'one probe for each server, not five');
  for (const answer of answers) {
    assert.deepEqual(onlineBy(answer.body.statuses), { 'stand-in-healthy': true, 'stand-in-failing': true, 'stand-in-refusing': true });
  }
});

test('a re-check soon after a round gets that round\'s answer at once, with no new probes', async () => {
  later(10);
  const started = performance.now();
  const again = await recheck();
  const took = performance.now() - started;

  assert.equal(again.status, 200);
  assert.equal(again.body.statuses.length, 3);
  assert.deepEqual(targets.map((t) => t.probes), [1, 1, 1]);
  assert.equal(took < ANSWER_DELAY_MS, true, `answered in ${took.toFixed(1)} ms, without waiting for a probe`);
});

test('the owner\'s re-check runs a new round once the interval has passed', async () => {
  later(6); // 16 seconds after the last round
  const res = await call('POST', '/api/status/check');
  assert.equal(res.status, 200);
  assert.deepEqual(targets.map((t) => t.probes), [2, 2, 2]);
});

test('eight re-checks that meet one failing server together are one strike and a 30 second pause, not eight and an hour', async () => {
  later(60);
  await freshList();
  failing.answer = 503;
  const answers = await Promise.all(Array.from({ length: 8 }, recheck));

  assert.equal(answers.every((a) => a.status === 200), true);
  assert.equal(answers.every((a) => onlineBy(a.body.statuses)['stand-in-failing'] === false), true);
  assert.equal(failing.probes, 1, 'the failing server was probed once');
  assert.deepEqual(
    (({ failures, backoffSeconds, revoked }) => ({ failures, backoffSeconds, revoked }))(backoff.getBackoffInfo('stand-in-failing')),
    { failures: 1, backoffSeconds: 30, revoked: false }
  );
  assert.equal(backoff.getBackoffInfo('stand-in-healthy'), null, 'a healthy server is not touched');
});

test('the pause is not made longer by re-checks during it, and the server is back as soon as it has run out', async () => {
  // Still failing, 20 seconds into the 30 second pause: a new round runs (the
  // interval has passed) but the paused server is not probed and gets no strike.
  later(20);
  await Promise.all(Array.from({ length: 8 }, recheck));
  assert.equal(failing.probes, 1);
  assert.equal(backoff.getBackoffInfo('stand-in-failing').failures, 1);
  assert.equal(backoff.getBackoffInfo('stand-in-failing').secondsUntilRetry, 10);

  // It recovers. Once the 30 seconds are over, the next round finds it.
  failing.answer = 200;
  later(16);
  const res = await recheck();
  assert.equal(onlineBy(res.body.statuses)['stand-in-failing'], true);
  assert.equal(backoff.getBackoffInfo('stand-in-failing'), null);
});

test('a server that is still failing after its pause gets the next step of the schedule, one step for one round', async () => {
  later(60);
  await freshList();
  failing.answer = 503;
  await Promise.all(Array.from({ length: 8 }, recheck));
  assert.equal(backoff.getBackoffInfo('stand-in-failing').backoffSeconds, 30);

  later(31);
  await Promise.all(Array.from({ length: 8 }, recheck));
  const info = backoff.getBackoffInfo('stand-in-failing');
  assert.equal(info.failures, 2);
  assert.equal(info.backoffSeconds, 120);
  failing.answer = 200;
});

test('a burst that meets a server refusing the token starts the one-day pause once', async () => {
  later(60);
  await freshList();
  refusing.answer = 403;
  await Promise.all(Array.from({ length: 8 }, recheck));
  const info = backoff.getBackoffInfo('stand-in-refusing');
  assert.equal(refusing.probes, 1);
  assert.equal(info.failures, 1);
  assert.equal(info.backoffSeconds, 86400);
  assert.equal(info.revoked, true);
  refusing.answer = 200;
});

test('a control: a device that may only look is still refused a request that changes something', async () => {
  const res = await call('POST', '/api/queue', { lookOnly: true, body: {} });
  assert.equal(res.status, 403);
  assert.equal(res.body.lookOnly, true);
});

test('nothing in these checks left this computer', () => {
  assert.deepEqual(refused, []);
});
