// Posters, kept on disk so a picture is fetched from a Plex server once and
// never again.
//
// Every poster the app shows lives on someone else's server, out on the
// internet. Measured, one costs about 200ms to fetch, and a browser will only
// open six connections at a time, so a screen of two dozen covers takes a
// couple of seconds and does it again on every device. That is the whole of the
// delay: it is the distance to those servers, not anything the app does with
// the picture afterwards. Fetching them directly from the browser instead of
// through this app measures exactly the same, so there is nothing to win by
// changing who does the fetching.
//
// There is a lot to win by not fetching twice. A cover never changes, so the
// second request for one is pure waste. Held on local disk, it comes back in
// about a millisecond rather than two hundred, and it is shared by every phone,
// laptop and TV in the house instead of each of them paying separately.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from './db.js';

const CACHE_DIR = path.join(DATA_DIR, 'posters');

// A poster is roughly 20KB, so this holds tens of thousands of them and still
// asks for well under a gigabyte of a 900GB disk. The cap exists so an
// unattended machine cannot slowly fill its own disk, not because the space is
// scarce.
let maxBytes = 750 * 1024 * 1024;
let pruneToBytes = 600 * 1024 * 1024;

// How much the cache holds right now. The cap used to be looked at only by
// prune(), at startup and every six hours, so between two of those anything
// that could ask for posters quickly could fill the disk the database lives
// on. prune() sets this from its count of the folder and every write adds to
// it, so the cap is checked each time a poster is stored. Not counted yet
// when null.
let cachedBytes = null;

// A prune that could not make room (files that will not delete, a folder
// that cannot be read) is not tried again for a while: it reads the whole
// folder, and a full cache would otherwise do that on every poster.
const STUCK_PRUNE_WAIT_MS = 60 * 1000;
let pruneStuckAt = 0;

fs.mkdirSync(CACHE_DIR, { recursive: true });

// Posters currently being fetched. Without this, a page asking for the same
// cover from several rows at once starts several identical downloads — the same
// stampede that made picking a library download it four times over.
const inFlight = new Map();

// The size the poster was fetched at is part of its identity. Without that,
// changing the width the app asks for would keep serving whatever size happened
// to be cached first, and the change would look like it had done nothing.
function keyFor(serverUri, imagePath, variant = '') {
  return crypto.createHash('sha1').update(`${serverUri}|${imagePath}|${variant}`).digest('hex');
}

function fileFor(key) {
  // Two levels of directory keep any single folder from holding tens of
  // thousands of entries, which some filesystems handle badly.
  const dir = path.join(CACHE_DIR, key.slice(0, 2));
  return { dir, file: path.join(dir, `${key.slice(2)}.img`) };
}

/** Is this poster on disk? An existence check, not a read. */
export function isCached(serverUri, imagePath, variant = '') {
  return fs.existsSync(fileFor(keyFor(serverUri, imagePath, variant)).file);
}

// Posters that recently could not be fetched. A dead or refusing server used
// to be asked again on every page load, two attempts of up to 15 seconds each,
// holding connections the whole time. A miss is remembered for a while
// instead, so the page just shows no picture until the server recovers.
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5000;
const recentFailures = new Map();

function recentlyFailed(key) {
  const at = recentFailures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < FAILURE_TTL_MS) return true;
  recentFailures.delete(key);
  return false;
}

function rememberFailure(key) {
  if (recentFailures.size >= MAX_FAILURES) recentFailures.delete(recentFailures.keys().next().value);
  recentFailures.set(key, Date.now());
}

/**
 * The cached bytes for a poster, or null if we have never fetched it.
 */
export function readCached(serverUri, imagePath, variant = '') {
  const { file } = fileFor(keyFor(serverUri, imagePath, variant));
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * Is there room under the cap for this many more bytes? A full cache is
 * pruned on the spot, oldest first, so the newest posters are the ones kept.
 */
function hasRoomFor(bytes) {
  // A folder that has not been counted cannot be kept under a cap.
  const fits = () => cachedBytes !== null && cachedBytes + bytes <= maxBytes;
  if (fits()) return true;
  if (Date.now() - pruneStuckAt < STUCK_PRUNE_WAIT_MS) return false;
  if (cachedBytes === null) prune();
  if (fits()) return true;
  if (cachedBytes !== null) prune(true);
  if (fits()) return true;
  pruneStuckAt = Date.now();
  return false;
}

function write(serverUri, imagePath, buffer, variant = '') {
  // With no room the poster is still shown, just not kept.
  if (!hasRoomFor(buffer.length)) return;
  const { dir, file } = fileFor(keyFor(serverUri, imagePath, variant));
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Written to a temporary name and moved into place, so a crash or a second
    // writer can never leave a half-written picture that looks complete.
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, file);
    cachedBytes += buffer.length;
  } catch (err) {
    // A cache that cannot write is slow, not broken. Never fail the request.
    console.error('[posters] could not cache:', err.message);
  }
}

/**
 * Fetch a poster, using the copy on disk when there is one.
 *
 * `fetchUpstream` is passed in rather than built here so this file never needs
 * to know anything about Plex tokens or which server a picture came from.
 */
export async function getPoster(serverUri, imagePath, fetchUpstream, variant = '') {
  const cached = readCached(serverUri, imagePath, variant);
  if (cached) return { buffer: cached, fromCache: true };

  const key = keyFor(serverUri, imagePath, variant);
  if (recentlyFailed(key)) return { buffer: null, fromCache: false };
  const existing = inFlight.get(key);
  if (existing) return existing;

  const work = (async () => {
    const buffer = await fetchUpstream();
    if (buffer) write(serverUri, imagePath, buffer, variant);
    else rememberFailure(key);
    return { buffer, fromCache: false };
  })();

  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Fetch posters into the cache ahead of being asked for them.
 *
 * The front page knows which covers it is about to show well before the browser
 * gets around to requesting them, so the wait can be spent before anyone is
 * looking at a blank grid. Deliberately unhurried: a handful at a time, and
 * anything already held is skipped, so this costs nothing on a warm cache.
 */
export function prewarm(entries, fetchUpstreamFor, concurrency = 4, variant = '') {
  // A cheap existence check, not a read: this runs on every front-page load
  // over hundreds of posters, and reading each whole file just to learn it is
  // there blocked every other request while it happened.
  const pending = entries.filter((e) => e && !isCached(e.serverUri, e.imagePath, variant));
  if (pending.length === 0) return;

  let index = 0;
  const worker = async () => {
    while (index < pending.length) {
      const entry = pending[index++];
      try {
        await getPoster(entry.serverUri, entry.imagePath, () => fetchUpstreamFor(entry), variant);
      } catch {
        // A poster that will not download is not worth interrupting the rest.
      }
    }
  };

  // Not awaited on purpose: this runs behind whatever asked for it.
  Promise.all(Array.from({ length: concurrency }, worker)).catch(() => {});
}

/**
 * Delete the least recently used posters once the cache outgrows its cap.
 * `makeRoom` is for a write that found the cache full: it prunes even when
 * the count is still just under the cap, or that write and every one after
 * it would be turned away while nothing was ever removed.
 */
export function prune(makeRoom = false) {
  try {
    const files = [];
    let total = 0;
    for (const bucket of fs.readdirSync(CACHE_DIR)) {
      const dir = path.join(CACHE_DIR, bucket);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        files.push({ file, size: stat.size, atime: stat.atimeMs });
        total += stat.size;
      }
    }
    if (makeRoom !== true && total <= maxBytes) {
      cachedBytes = total;
      return { total, removed: 0 };
    }

    files.sort((a, b) => a.atime - b.atime);
    let removed = 0;
    for (const entry of files) {
      if (total <= pruneToBytes) break;
      try {
        fs.unlinkSync(entry.file);
      } catch {
        // Gone already or locked: skip it rather than abandon the whole prune.
        continue;
      }
      total -= entry.size;
      removed += 1;
    }
    cachedBytes = total;
    lastStats = { count: files.length - removed, bytes: total, at: Date.now() };
    console.log(`[posters] pruned ${removed} cached posters, now ${(total / 1048576).toFixed(0)}MB`);
    return { total, removed };
  } catch (err) {
    // The running count is left as it was: setting it to zero here would
    // open the cap again.
    console.error('[posters] prune failed:', err.message);
    return { total: 0, removed: 0 };
  }
}

/** For tests: a cap small enough to reach, and a fresh count. */
export function setLimitsForTests(max, pruneTo) {
  maxBytes = max;
  pruneToBytes = pruneTo;
  cachedBytes = null;
  pruneStuckAt = 0;
}

// Counting the cache means a stat of every file, tens of thousands of them, on
// the request thread. The health endpoint asks often, so the count is reused
// for a few minutes.
const STATS_TTL_MS = 5 * 60 * 1000;
let lastStats = null;

export function stats() {
  if (lastStats && Date.now() - lastStats.at < STATS_TTL_MS) return { count: lastStats.count, bytes: lastStats.bytes };
  let count = 0;
  let bytes = 0;
  try {
    for (const bucket of fs.readdirSync(CACHE_DIR)) {
      const dir = path.join(CACHE_DIR, bucket);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        count += 1;
        bytes += fs.statSync(path.join(dir, name)).size;
      }
    }
  } catch {
    // An unreadable cache directory reports as empty rather than throwing.
  }
  lastStats = { count, bytes, at: Date.now() };
  return { count, bytes };
}
