// How much of a library one read takes.
//
// A read used to plan its pages from the item count the Plex server declares,
// and to keep whatever each page carried. The server (often someone else's)
// so chose how many requests one read made and how many titles it kept in
// memory. The app now has a ceiling of its own on both. These checks run
// against a stand-in server on this computer that declares what it likes,
// with the ceiling lowered so that a few thousand dummy titles reach it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const TOKEN = 'dummy-server-token';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = TOKEN;
// The stand-in server here is plain http on this computer.
process.env.PLEX_ALLOW_HTTP = '1';

const PAGE_SIZE = 500; // as in plex-library.js
const CEILING = 1200; // in place of the real 500,000
const films = (section, count, from = 0) =>
  Array.from({ length: count }, (_, n) => ({ ratingKey: String(section * 1000000 + from + n), type: 'movie', title: `Dummy Film ${section}-${from + n}`, year: 2000 }));

// What the stand-in answers for each library: { declares, page(start) }.
const honest = (section, count) => {
  const all = films(section, count);
  return { declares: count, page: (start) => all.slice(start, start + PAGE_SIZE) };
};
const libraries = {
  // A full first page, then a count far above what is there: 50 titles on every later page.
  1: { declares: 5000, page: (start) => (start === 0 ? films(1, PAGE_SIZE) : films(1, 50, start)) },
  2: { declares: 200_000, page: (start) => (start === 0 ? films(2, PAGE_SIZE) : films(2, 50, start)) },
  // An ordinary library that is larger than the ceiling.
  3: honest(3, 2100),
  // An ordinary library that is smaller.
  4: honest(4, 1100),
  // Every page carries 800 titles, whatever size was asked for.
  5: { declares: 1100, page: (start) => films(5, 800, start) },
  // A count that is not a number.
  6: { declares: 'lots', page: (start) => (start === 0 ? films(6, PAGE_SIZE) : []) },
};

const asked = [];
const pagesOf = (section) => asked.filter((p) => p === String(section)).length;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stand-in');
  const page = url.pathname.match(/^\/library\/sections\/(\d+)\/all$/);
  if (!page || req.headers['x-plex-token'] !== TOKEN) {
    res.writeHead(404);
    return res.end();
  }
  asked.push(page[1]);
  const library = libraries[page[1]];
  const items = library.page(Number(url.searchParams.get('X-Plex-Container-Start') || 0));
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ MediaContainer: { size: items.length, totalSize: library.declares, Metadata: items } }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const uri = `http://127.0.0.1:${server.address().port}`;
const connections = [{ uri, local: true, protocol: 'http' }];

const plexLibrary = await import('../src/plex-library.js');
const { getLibraryItems } = plexLibrary;
plexLibrary.setReadLimitsForTests?.({ maxItems: CEILING });

after(() => {
  plexLibrary.setReadLimitsForTests?.();
  server.closeAllConnections();
  server.close();
});

/** Read a library and return its items with every line the read logged. */
async function read(section, form = connections) {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { items: await getLibraryItems(uri, section, TOKEN, form), lines };
  } finally {
    console.log = realLog;
  }
}
const trimLines = (lines) => lines.filter((line) => /reading the first/.test(line));
const pagesUpToCeiling = Math.ceil(CEILING / PAGE_SIZE);

test('the real ceiling is far above the largest library the app is used with', () => {
  assert.equal(plexLibrary.MAX_LIBRARY_ITEMS, 500_000);
  assert.ok(plexLibrary.MAX_LIBRARY_ITEMS >= 5 * 99_000);
});

test('a server that declares more titles than the ceiling is read up to the ceiling, whatever number it gives', async () => {
  for (const [section, declared] of [['1', 5000], ['2', 200_000]]) {
    const { items, lines } = await read(section);
    assert.equal(pagesOf(section), pagesUpToCeiling, `library ${section}: the pages asked for follow the ceiling, not the ${declared} declared`);
    assert.equal(items.length, PAGE_SIZE + 50 * (pagesUpToCeiling - 1));
    assert.deepEqual(trimLines(lines), [`  Library section ${section} declares ${declared} items: reading the first ${CEILING} only`], 'one line says so');
    assert.equal(trimLines(lines).some((line) => line.includes('Dummy Film')), false, 'and it names no title');
  }
});

test('the same holds when the server is asked straight at one address', async () => {
  const before = pagesOf(1);
  const { items } = await read('1', null);
  assert.equal(pagesOf(1) - before, pagesUpToCeiling);
  assert.ok(items.length <= CEILING);
});

test('a library larger than the ceiling is trimmed to exactly the ceiling', async () => {
  const { items, lines } = await read('3');
  assert.equal(pagesOf(3), pagesUpToCeiling);
  assert.equal(items.length, CEILING);
  assert.deepEqual([items[0].title, items[CEILING - 1].title], ['Dummy Film 3-0', `Dummy Film 3-${CEILING - 1}`], 'the first titles, in order');
  assert.equal(trimLines(lines).length, 1);
});

test('a library under the ceiling is read whole, and nothing is said about trimming', async () => {
  const { items, lines } = await read('4');
  assert.equal(items.length, 1100);
  assert.equal(pagesOf(4), 3);
  assert.deepEqual(trimLines(lines), []);
});

test('a page never adds more titles than were asked for', async () => {
  const { items, lines } = await read('5');
  // 1100 declared is three pages; each sent 800 titles and 500 of them count.
  assert.equal(pagesOf(5), 3);
  assert.equal(items.length, CEILING, 'three pages of 500, trimmed to the ceiling; not three of 800');
  assert.deepEqual(trimLines(lines), [`  Library section 5 holds more than ${CEILING} items: reading the first ${CEILING} only`], 'and one line says so here too');
  plexLibrary.setReadLimitsForTests?.({ maxItems: 5000 });
  try {
    assert.equal((await read('5')).items.length, 3 * PAGE_SIZE);
  } finally {
    plexLibrary.setReadLimitsForTests?.({ maxItems: CEILING });
  }
});

test('a declared count that is not a number plans no further pages', async () => {
  const { items } = await read('6');
  assert.equal(pagesOf(6), 1);
  assert.equal(items.length, PAGE_SIZE);
});
