// "Ask" and voice search turn one sentence into filters with a handful of
// text patterns. The text was read whole, however long it was, and one
// pattern (the actor's name after "with") followed every "with" to the end
// of the text when no ending came. A body of 100,000 characters made of
// "with with with ..." held the whole app up for about a second, for every
// device, and any device that may look could send it.
//
// Dummy sentences only; the two routes are asked over this computer's
// loopback as a device on the Wi-Fi that may only look. No network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DISABLE_MDNS = '1';
delete process.env.PLEX_TOKEN;
delete process.env.TRUST_PROXY;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('http://127.0.0.1:')) return realFetch(input, init);
  throw new Error('fetch failed (the tests use no network)');
};

// Imported only after DATA_DIR is set: the database opens on import.
const voice = await import('../src/voice-parse.js');
const { parseVoiceQuery } = voice;
const { app } = await import('../src/app.js');
await import('../src/routes/discovery.js');
await import('../src/routes/ask-swipe-shelves.js');

const listener = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
after(() => {
  listener.close();
  globalThis.fetch = realFetch;
});
const base = `http://127.0.0.1:${listener.address().port}`;

// What each sentence was understood as before the limit was added. These
// answers are the ones the old parser gave, word for word.
const ORDINARY = [
  ['something funny under two hours, nothing sad', { maxRuntime: 120, genres: ['Comedy'], mood: 'funny', excludeGenres: ['Drama'] }],
  ['a comedy with adam sandler', { genres: ['Comedy'], actor: 'adam sandler' }],
  ['movies starring Tom Hanks from the 90s', { yearFrom: 1990, yearTo: 1999, actor: 'tom hanks', type: 'movie' }],
  ['a thriller featuring denzel washington rated above 7', { minRating: 7, genres: ['Thriller'], actor: 'denzel washington' }],
  ['show me a scary movie with jamie lee curtis.', { genres: ['Horror'], actor: 'jamie lee curtis', type: 'show' }],
  ['horror movies with vincent price in black and white', { genres: ['Horror'], actor: 'vincent price', type: 'movie' }],
  ['a western with clint eastwood under 100 minutes', { maxRuntime: 100, genres: ['Western'], actor: 'clint eastwood' }],
  ['something cozy', { mood: 'cozy', genres: ['Family', 'Romance', 'Animation', 'Comedy'], excludeGenres: ['Horror', 'War'] }],
  ['a highly rated documentary since 2015', { yearFrom: 2015, minRating: 7.5, genres: ['Documentary'] }],
  ['animated family films before 2000, no romance', { yearTo: 2000, genres: ['Animation', 'Family'], type: 'movie', excludeGenres: ['Romance'] }],
  ['sci-fi series over 2 hours', { minRuntime: 120, minRating: 2, genres: ['Sci-Fi'], type: 'show' }],
  ['a tv show with bryan cranston, not too heavy', { actor: 'bryan cranston', type: 'show', excludeGenres: ['Drama', 'War'] }],
  ['classic war films at least 90 minutes', { minRuntime: 90, minRating: 8, genres: ['War'], type: 'movie' }],
  ['with 2 friends tonight', {}],
  ['Starring Meryl Streep', { actor: 'meryl streep' }],
  ['a crime drama with al pacino and robert de niro rated higher than 8', { minRating: 8, genres: ['Drama', 'Crime'], actor: 'al pacino and robert de niro' }],
  // More than sixty letters after "with" and no ending before the end of the
  // sentence: still read to the end, as it always was.
  [
    'something with a strong lead and a twist ending that nobody sees coming at all tonight',
    { actor: 'a strong lead and a twist ending that nobody sees coming at all tonight' },
  ],
  ['epic', { mood: 'epic', minRuntime: 130, minRating: 7.5 }],
  ['nothing scary', { excludeGenres: ['Horror', 'Thriller'] }],
  ['a film with a', { type: 'movie' }],
];

// The text the audit used: "with " over and over, ending in a character that
// is neither part of a name nor an ending. Just under what the routes accept.
const HOSTILE = 'with '.repeat(19999) + '1';

function timed(run) {
  const started = performance.now();
  const answer = run();
  return { answer, took: performance.now() - started };
}

test('ordinary sentences are understood exactly as they were', () => {
  for (const [sentence, filters] of ORDINARY) {
    const answer = parseVoiceQuery(sentence);
    assert.deepEqual(answer.filters, filters, sentence);
    assert.equal(answer.transcript, sentence, 'the sentence is handed back as it was sent');
  }
});

test('a sentence as long as the limit is read to its last word', () => {
  const sentence = ' a comedy with adam sandler'.padStart(500, 'a quiet night in at home ');
  assert.equal(sentence.length, 500);
  assert.deepEqual(parseVoiceQuery(sentence).filters, { genres: ['Comedy'], actor: 'adam sandler' });
});

test('only the first 500 characters of a request are read', () => {
  assert.equal(voice.MAX_REQUEST_CHARS, 500);
  // What comes after the limit is not acted on...
  assert.deepEqual(parseVoiceQuery(`${'x'.repeat(500)} a comedy under two hours`).filters, {});
  // ...and what came before it still is.
  assert.deepEqual(parseVoiceQuery(`a comedy under two hours, ${'x'.repeat(5000)} nothing funny`).filters, {
    maxRuntime: 120,
    genres: ['Comedy'],
  });
});

test('a very long text of "with with with" is answered at once', () => {
  const { answer, took } = timed(() => parseVoiceQuery(HOSTILE));
  assert.ok(took < 300, `took ${Math.round(took)} ms`);
  assert.equal(answer.transcript, HOSTILE);
  // Only the part that was read can end up in the answer.
  assert.ok(JSON.stringify(answer.filters).length < 600);
});

test('the name pattern costs a fixed amount for each "with", even on a text nobody cut short', () => {
  // The pattern alone, on the whole text. It took about a second.
  const { answer, took } = timed(() => voice.parseActor(HOSTILE));
  assert.equal(answer, null);
  assert.ok(took < 500, `took ${Math.round(took)} ms`);
  assert.deepEqual(voice.parseActor(`${HOSTILE} with tom hanks`), { actor: 'tom hanks' });
});

test('both routes answer a look-only device that sends such a text without holding the app up', async () => {
  const guest = (route, body) =>
    realFetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.168.1.50' },
      body: JSON.stringify(body),
    });

  const short = await guest('/api/voice/parse', { transcript: 'a comedy with adam sandler' });
  assert.equal(short.status, 200);
  assert.deepEqual((await short.json()).filters, { genres: ['Comedy'], actor: 'adam sandler' });

  for (const [route, body] of [['/api/voice/parse', { transcript: HOSTILE }], ['/api/ask', { question: HOSTILE }]]) {
    const started = performance.now();
    const res = await guest(route, body);
    await res.text();
    const took = performance.now() - started;
    assert.equal(res.status, 200, route);
    assert.ok(took < 400, `${route} took ${Math.round(took)} ms`);
  }
});
