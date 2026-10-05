import { PLEX_REQUEST_TIMEOUT_MS, failureText, fetchFromServerWithFallback } from './plex-connections.js';
import { externalIds, proxiedImageUrl } from './plex-images.js';
import { plexId } from './plex-ids.js';
import { MAX_SMALL_ANSWER_BYTES, plexFetch } from './plex-fetch.js';
import { forgetServersNotIn, getListedLibraryKeys, saveListedLibraryKeys } from './library-cache.js';
import { shouldAttempt } from './server-backoff.js';

// ---------- Limits on a read ----------

/**
 * The most titles one read of a library plans for and keeps. A read used to
 * take its page plan from the count the Plex server declares, so the server
 * (often someone else's) chose how many requests one read made and how much
 * it kept. The largest library this was sized against holds about 99,000
 * titles; five times that still fits in the memory a read may use.
 */
export const MAX_LIBRARY_ITEMS = 500_000;

// The real values, and one place to lower them in a test so that a limit can
// be reached in milliseconds and with a few thousand dummy titles.
const REAL_READ_LIMITS = Object.freeze({
  maxItems: MAX_LIBRARY_ITEMS,
  // One page of a library (500 titles): the request and the whole answer.
  // A read of a large library is many such requests, each with this limit of
  // its own; the read as a whole has none.
  pageTimeoutMs: PLEX_REQUEST_TIMEOUT_MS,
  // A server's list of sections, the whole answer.
  sectionListTimeoutMs: 15_000,
});
const readLimits = { ...REAL_READ_LIMITS };

/** For tests: limits small enough to reach. Call with nothing to put the real ones back. */
export function setReadLimitsForTests(limits = {}) {
  Object.assign(readLimits, REAL_READ_LIMITS, limits);
}

/**
 * Get all libraries from a specific Plex server.
 * Uses connection failover if the primary URI fails.
 */
export async function getLibraries(serverUri, plexToken, connections) {
  // If connections provided, use failover; otherwise use direct URI (backward compat)
  let res;
  if (connections && connections.length > 0) {
    // A list of sections is a small, quick answer. It used to wait up to two
    // minutes for the headers and then for the body with no limit at all.
    res = await fetchFromServerWithFallback(connections, '/library/sections', plexToken, {
      headers: { Accept: 'application/json' },
      maxAnswerBytes: MAX_SMALL_ANSWER_BYTES,
      timeoutMs: readLimits.sectionListTimeoutMs,
    });
  } else {
    // The token goes in a header, so it is never part of an address that
    // could end up in an error message or a log line.
    res = await plexFetch(`${serverUri}/library/sections`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': plexToken },
      signal: AbortSignal.timeout(readLimits.sectionListTimeoutMs),
      maxAnswerBytes: MAX_SMALL_ANSWER_BYTES,
    });

    if (!res.ok) {
      throw new Error(
        `Failed to get libraries from ${serverUri}: ${res.status} ${res.statusText}`
      );
    }
  }

  const data = await res.json();
  const directories = data.MediaContainer?.Directory || [];

  return directories
    .filter((d) => d.type === 'movie' || d.type === 'show')
    .map((d) => ({
      key: d.key,
      title: d.title,
      type: d.type,
      serverUri,
    }));
}

// ---------- Which libraries may be read ----------
//
// The app lists a server's movie and show libraries and nothing else. That
// filter (in getLibraries above) used to shape the list and do no more: every
// route that reads a library took the section number from the request, and the
// server's token then fetched whatever number was named, a photo or music
// section included. So the list is now also the rule. It is kept here per
// server, in memory and written down (library-cache.js), and a section named
// in a request is compared with it before a stored copy is served and before
// Plex is asked.

// How often Plex may be asked again about a section that is not on the list.
const LIST_RECHECK_MS = 60_000;
// How long a request waits for that answer before the list on hand decides.
const LIST_WAIT_MS = 10_000;

const listedByServer = new Map(); // serverKey -> { keys: Set, askedAt, saved }
const listsBeingRead = new Map(); // serverKey -> promise, one question at a time

/** The list on hand for a server: from memory, else from what was written down. */
function listOnHand(serverKey) {
  const held = listedByServer.get(serverKey);
  if (held) return held;
  const written = { keys: new Set(getListedLibraryKeys(serverKey)), askedAt: 0, saved: false };
  // Kept only when there is something to keep: the key can come straight from
  // a request, and made-up server names must not pile up in memory.
  if (written.keys.size > 0) listedByServer.set(serverKey, written);
  return written;
}

/**
 * Take note of the libraries a server lists. Called wherever the list is read
 * from Plex, so the rule follows what people are shown.
 */
export function rememberListedLibraries(serverKey, libraries) {
  const keys = (libraries || []).map((lib) => String(lib.key));
  const before = listOnHand(serverKey);
  const unchanged = before.saved && keys.length === before.keys.size && keys.every((key) => before.keys.has(key));
  if (!unchanged) {
    const dropped = saveListedLibraryKeys(serverKey, keys);
    if (dropped > 0) console.log(`Dropped ${dropped} stored section(s) the app does not list for server ${serverKey}`);
  }
  listedByServer.set(serverKey, { keys: new Set(keys), askedAt: Date.now(), saved: true });
}

/**
 * A server that plex.tv no longer names keeps no list of libraries and no
 * stored library: the share has ended, and what was copied while it lasted
 * goes with it. `serverKeys` are the servers plex.tv named in an answer it
 * has just given. getServers calls this on every such answer; it must never
 * be called with a list kept from earlier (see forgetServersNotIn).
 *
 * One line is logged per server forgotten, with counts and no titles.
 * Returns what forgetServersNotIn returns.
 */
export function forgetListedLibrariesExcept(serverKeys) {
  const keep = new Set((Array.isArray(serverKeys) ? serverKeys : []).filter(Boolean).map(String));
  if (keep.size === 0) return [];
  const gone = forgetServersNotIn([...keep]);
  // The list in memory too, or isRememberedLibrary would go on saying yes
  // until the next restart.
  for (const serverKey of [...listedByServer.keys()]) {
    if (!keep.has(serverKey)) listedByServer.delete(serverKey);
  }
  for (const { serverKey, listed, stored } of gone) {
    console.log(
      `Server ${serverKey} is no longer on the account's list at plex.tv: removed its ${listed} listed librar${listed === 1 ? 'y' : 'ies'} and ${stored} stored cop${stored === 1 ? 'y' : 'ies'}`
    );
  }
  return gone;
}

/**
 * The movie and show libraries of a server, read from Plex and noted as the
 * libraries that may be read. Use this instead of getLibraries wherever the
 * server object is at hand.
 */
export async function listLibraries(server, token) {
  const libraries = await getLibraries(server.uri, token, server.connections);
  rememberListedLibraries(server.clientIdentifier, libraries);
  return libraries;
}

/**
 * Is this library on the list on hand for that server? No network: the answer
 * comes from memory or from what was written down, so it also works while the
 * server is offline and before plex.tv has answered.
 */
export function isRememberedLibrary(serverKey, libraryKey) {
  return listOnHand(String(serverKey ?? '')).keys.has(String(libraryKey ?? ''));
}

/**
 * Is this a library the app lists for this server (one of its movie or show
 * libraries)? Call it with a section key that came from a request, before a
 * stored copy is served and before Plex is asked with the server's token.
 *
 *   const server = servers.find((s) => s.clientIdentifier === serverKey);
 *   if (!(await isListedLibrary(server, libraryKey, server.accessToken || token))) {
 *     return res.status(404).json({ error: 'Library not found' });
 *   }
 *
 * `server` is an entry of the server list (clientIdentifier, uri, connections,
 * reachable); `token` is that server's token. The key is compared exactly, as
 * text, so "07" does not pass for "7". A library on the list on hand passes
 * at once, with no request to Plex. One that is not makes Plex list its
 * sections again (at most once a minute per server, and not while the server
 * is known to be down), in case the library is new; if Plex cannot be asked,
 * the answer is no.
 */
export async function isListedLibrary(server, libraryKey, token) {
  const serverKey = server?.clientIdentifier;
  if (!serverKey) return false;
  const key = String(libraryKey ?? '');
  const onHand = listOnHand(serverKey);
  if (onHand.keys.has(key)) return true;

  if (Date.now() - onHand.askedAt < LIST_RECHECK_MS) return false;
  if (server.reachable === false || !shouldAttempt(serverKey)) return false;

  let reading = listsBeingRead.get(serverKey);
  if (!reading) {
    // Noted before the answer arrives, so a server that does not answer is
    // not asked again by every request that follows.
    listedByServer.set(serverKey, { ...onHand, askedAt: Date.now() });
    reading = listLibraries(server, token)
      .catch(() => null) // Plex cannot be asked right now: the list on hand stands.
      .finally(() => listsBeingRead.delete(serverKey));
    listsBeingRead.set(serverKey, reading);
  }
  let timer;
  await Promise.race([reading, new Promise((resolve) => { timer = setTimeout(resolve, LIST_WAIT_MS); })]);
  clearTimeout(timer);
  return listOnHand(serverKey).keys.has(key);
}

/**
 * The library section a Plex item sits in, as text, or null when Plex did not
 * say. `metadata` is what Plex answered for /library/metadata/<id>: the whole
 * answer, its MediaContainer, or the item itself (each carries
 * librarySectionID).
 */
export function sectionOfItem(metadata) {
  const container = metadata?.MediaContainer || metadata;
  const item = container?.Metadata?.[0] || container;
  const section = item?.librarySectionID ?? container?.librarySectionID;
  return section === undefined || section === null || section === '' ? null : String(section);
}

/**
 * Does this Plex item belong to a library the app lists? For routes that take
 * an item number from a request (a download, a cast to the TV, a play
 * command): read /library/metadata/<id> as they already do, then check the
 * answer before anything is handed out or sent on.
 *
 *   const data = await res.json(); // the answer for /library/metadata/<id>
 *   if (!(await isListedItem(server, data, server.accessToken || token))) {
 *     return res.status(404).json({ error: 'Item not found' });
 *   }
 *
 * The item number alone does not say which section it is in, so this check
 * comes after that one read of the item, and before the file, ticket or play
 * command that follows. An answer that does not name a section is refused.
 */
export async function isListedItem(server, metadata, token) {
  const section = sectionOfItem(metadata);
  if (section === null) return false;
  return isListedLibrary(server, section, token);
}

/** Wait, unless nobody is waiting for the read any more. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const gone = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', gone);
      resolve();
    }, ms);
    signal?.addEventListener('abort', gone, { once: true });
  });
}

/**
 * Fetch with retry + exponential backoff.
 * `signal` (optional) ends it at once, with no retry: nobody is waiting.
 * `options.timeoutMs` is the deadline for one attempt, headers and body
 * together; the rest of `options` goes to fetch.
 */
async function fetchWithRetry(url, options = {}, signal = null, maxRetries = 3) {
  const { timeoutMs = PLEX_REQUEST_TIMEOUT_MS, ...rest } = options;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal?.throwIfAborted();
    // One deadline for the whole answer, and the caller's signal with it.
    // Neither is taken away when the headers arrive: both must still be in
    // force while the caller reads the body (see fetchFromServerWithFallback).
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const res = await plexFetch(url, { ...rest, signal: signal ? AbortSignal.any([deadline, signal]) : deadline });

      if (res.ok) return res;

      // Retry on 502, 503, 504 (server overloaded/timeout)
      if ([502, 503, 504].includes(res.status) && attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 15000);
        console.log(`  Retry ${attempt + 1}/${maxRetries} after ${res.status}, waiting ${delay}ms...`);
        await pause(delay, signal);
        continue;
      }

      throw new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      // Stopped on purpose, or sent somewhere it must not go: trying again
      // would only repeat it.
      if (signal?.aborted) throw signal.reason;
      if (err.name === 'OffOriginError') throw err;
      // The deadline reports itself as TimeoutError.
      if ((err.name === 'AbortError' || err.name === 'TimeoutError') && attempt < maxRetries) {
        const delay = Math.min(3000 * Math.pow(2, attempt), 20000);
        console.log(`  Retry ${attempt + 1}/${maxRetries} after timeout, waiting ${delay}ms...`);
        await pause(delay, signal);
        continue;
      }
      if (attempt === maxRetries) throw err;
    }
  }
}

/**
 * Fetch with retry + exponential backoff, using connection fallback.
 * `signal` (optional) stops the retries and is handed to the request itself,
 * so a page already asked for is given up on at once when nobody is waiting,
 * whether its headers or its body are still on the way. It used to run to
 * its end, and a body that never ended kept the read's place for good.
 */
async function fetchWithRetryAndFallback(connections, path, token, options = {}, signal = null, maxRetries = 3) {
  if (!connections || connections.length === 0) {
    // Fall back to fetchWithRetry with the path as a full URL
    return fetchWithRetry(path, options, signal, maxRetries);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal?.throwIfAborted();
    try {
      const res = await fetchFromServerWithFallback(connections, path, token, { ...options, signal });
      return res;
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 15000);
        console.log(`  Retry ${attempt + 1}/${maxRetries} after error: ${err.message}, waiting ${delay}ms...`);
        await pause(delay, signal);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Map raw Plex metadata item to our standard item shape.
 */
function mapPlexItem(item, serverUri) {
  return {
    ratingKey: item.ratingKey,
    title: item.title,
    year: item.year,
    type: item.type,
    summary: item.summary,
    tagline: item.tagline || null,
    originalTitle: item.originalTitle || null,
    thumb: proxiedImageUrl(serverUri, item.thumb),
    guid: item.guid || null,
    guids: (item.Guid || []).map((g) => g.id),
    ...externalIds((item.Guid || []).map((g) => g.id)),
    genres: (item.Genre || []).map((g) => g.tag),
    collections: (item.Collection || []).map((c) => c.tag),
    countries: (item.Country || []).map((c) => c.tag),
    duration: item.duration,
    contentRating: item.contentRating,
    originallyAvailableAt: item.originallyAvailableAt,
    audienceRating: item.audienceRating,
    rating: item.rating,
    studio: item.studio,
    actors: (item.Role || []).map((r) => r.tag),
    director: (item.Director || []).map((d) => d.tag).join(', ') || null,
    writers: (item.Writer || []).map((w) => w.tag),
    viewCount: item.viewCount || 0,
    viewOffset: item.viewOffset || null,
    addedAt: item.addedAt || null,
    lastViewedAt: item.lastViewedAt || null,
    media: (item.Media || []).map((m) => ({
      id: m.id,
      duration: m.duration,
      bitrate: m.bitrate,
      width: m.width,
      height: m.height,
      videoCodec: m.videoCodec,
      audioCodec: m.audioCodec,
      audioChannels: m.audioChannels,
      videoResolution: m.videoResolution,
      videoDynamicRange: m.videoDynamicRange,
      container: m.container,
      videoFrameRate: m.videoFrameRate,
      parts: (m.Part || []).map((p) => ({
        id: p.id,
        key: p.key,
        file: p.file,
        size: p.size,
        container: p.container,
      })),
    })),
  };
}

// ---------- Reading a whole library ----------
//
// A read pulls every title of a library into memory, from a server that is
// often someone else's. Only loadOrFetchLibrary used to make sure the same
// library was not read twice at once; every other route called getLibraryItems
// directly, so requests arriving together each ran a full read of their own,
// two routes did so on every request, and nothing limited how many ran. That
// is how this process has run out of memory before.
//
// The rule now sits here, at the read itself, where no caller can go round it:
//   - one read per library at a time; everyone asking for it meanwhile waits
//     on that one read and gets the same array (treat it as read-only);
//   - at most MAX_LIBRARY_READS reads in total; the rest wait their turn and
//     none fails for having waited;
//   - a read is stopped once everyone waiting for it has gone away.

/** How many libraries may be read from Plex at the same time, over all servers. */
export const MAX_LIBRARY_READS = 2;

const libraryReads = new Map(); // "<server address> <library> <token>" -> the read in flight
let readsRunning = 0;
const readsWaitingForRoom = [];

function nobodyWaiting() {
  const err = new Error('Nobody is waiting for this library any more');
  err.name = 'AbortError';
  return err;
}

/**
 * Run `work` as soon as fewer than MAX_LIBRARY_READS reads are running. If
 * `signal` fires while it is still waiting for room, it never starts.
 */
function whenThereIsRoom(signal, work) {
  return new Promise((resolve, reject) => {
    const giveUp = () => {
      const at = readsWaitingForRoom.indexOf(start);
      if (at !== -1) readsWaitingForRoom.splice(at, 1);
      reject(signal.reason);
    };
    const start = () => {
      signal.removeEventListener('abort', giveUp);
      readsRunning += 1;
      Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          // The place goes to whoever has waited longest.
          readsRunning -= 1;
          const next = readsWaitingForRoom.shift();
          if (next) next();
        });
    };
    if (readsRunning < MAX_LIBRARY_READS) {
      start();
      return;
    }
    readsWaitingForRoom.push(start);
    signal.addEventListener('abort', giveUp, { once: true });
  });
}

/**
 * Wait on a read with everyone else who wants it. A caller with a `signal`
 * leaves when it fires, and the read is stopped when the last such caller has
 * left. A caller without one (background work) never leaves, so a read it is
 * waiting on always finishes.
 */
function waitOnRead(key, read, signal) {
  if (!signal) {
    read.wantedByBackground = true;
    return read.promise;
  }
  read.waiting += 1;
  return new Promise((resolve, reject) => {
    const leave = () => {
      read.waiting -= 1;
      if (read.waiting === 0 && !read.wantedByBackground) {
        // Forgotten first, so a request arriving now starts a read of its own
        // instead of joining one that is being stopped.
        if (libraryReads.get(key) === read) libraryReads.delete(key);
        read.controller.abort(nobodyWaiting());
      }
      reject(nobodyWaiting());
    };
    if (signal.aborted) {
      leave();
      return;
    }
    signal.addEventListener('abort', leave, { once: true });
    read.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
  });
}

/**
 * Get all items from a specific library on a Plex server.
 * Uses pagination with parallel page fetching (3 pages at a time).
 * Supports connection failover via the connections parameter.
 * Includes retry logic for flaky connections.
 *
 * Calls for the same library at the same time share one read (see above), so
 * the array returned may be in other hands too: do not change it.
 *
 * @param {string} serverUri - Primary server URI
 * @param {string} libraryKey - Library section key
 * @param {string} plexToken - Auth token
 * @param {Array} [connections] - Optional connections array for failover
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - fires when the caller no longer
 *   wants the answer (the device that asked has gone). Leave it out for
 *   background work.
 */
export async function getLibraryItems(serverUri, libraryKey, plexToken, connections, options = {}) {
  const section = plexId(libraryKey);
  const key = `${serverUri} ${section} ${plexToken}`;

  let read = libraryReads.get(key);
  if (!read) {
    const controller = new AbortController();
    read = { controller, waiting: 0, wantedByBackground: false };
    read.promise = whenThereIsRoom(controller.signal, () =>
      readLibraryItems(serverUri, section, plexToken, connections, controller.signal)
    ).finally(() => {
      if (libraryReads.get(key) === read) libraryReads.delete(key);
      // The read is over. When it failed part-way, the other pages of its
      // last batch are still on their way, and nobody wants them now.
      controller.abort(nobodyWaiting());
    });
    // Everyone may have left by the time a stopped read reports its end.
    read.promise.catch(() => {});
    libraryReads.set(key, read);
  }
  return waitOnRead(key, read, options?.signal);
}

/** One full read of a library. Only getLibraryItems calls this. */
async function readLibraryItems(serverUri, section, plexToken, connections, signal) {
  const PAGE_SIZE = 500;
  const PARALLEL_PAGES = 3;

  const fetchPage = (offset) => {
    const pagePath = `/library/sections/${section}/all?includeGuids=1&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${PAGE_SIZE}`;
    if (connections && connections.length > 0) {
      return fetchWithRetryAndFallback(connections, pagePath, plexToken, {
        headers: { Accept: 'application/json' },
        timeoutMs: readLimits.pageTimeoutMs,
      }, signal);
    }
    // The token goes in a header, not in the address.
    return fetchWithRetry(`${serverUri}${pagePath}`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': plexToken },
      timeoutMs: readLimits.pageTimeoutMs,
    }, signal);
  };

  // The body of a page. The request's deadline and the read's stop signal are
  // still in force here, so a body that stalls or trickles ends with them.
  const pageOf = async (res) => {
    try {
      return await res.json();
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (err?.name !== 'TimeoutError') throw err;
      // In plain words, as a request that timed out before its headers is.
      const late = new Error(failureText(err));
      late.name = 'TimeoutError';
      throw late;
    }
  };

  // Fetch the first page to get totalSize
  const firstRes = await fetchPage(0);

  const firstData = await pageOf(firstRes);
  const firstContainer = firstData.MediaContainer || {};
  // What a page holds, as a list of at most the PAGE_SIZE titles asked for.
  const itemsOf = (container) => (Array.isArray(container.Metadata) ? container.Metadata.slice(0, PAGE_SIZE) : []);
  const firstPageItems = itemsOf(firstContainer);
  // The count the server declares says how far to read, up to the app's own
  // ceiling. It is the server's number, so it is never the limit itself.
  const { maxItems } = readLimits;
  const said = Number(firstContainer.totalSize || firstContainer.size || firstPageItems.length);
  const declared = Number.isNaN(said) ? firstPageItems.length : said;
  const totalSize = Math.min(declared, maxItems);
  // Said once per read, whichever way the ceiling was reached.
  let saidTrimmed = false;
  const sayTrimmed = (why) => {
    if (saidTrimmed) return;
    saidTrimmed = true;
    console.log(`  Library section ${section} ${why}: reading the first ${maxItems} only`);
  };
  /** `items`, cut to the ceiling when it holds more. */
  const upToCeiling = (items) => {
    if (items.length <= maxItems) return items;
    sayTrimmed(`holds more than ${maxItems} items`);
    return items.slice(0, maxItems);
  };
  if (declared > maxItems) sayTrimmed(`declares ${declared} items`);

  console.log(`  Library has ${totalSize} total items, fetching in pages of ${PAGE_SIZE}...`);

  // Counted, not kept: holding every raw Plex item beside its mapped copy
  // doubled the memory of a read for the sake of a progress line.
  let fetched = firstPageItems.length;
  const mappedFirstPage = firstPageItems.map((item) => mapPlexItem(item, serverUri));

  console.log(`  Fetched ${fetched}/${totalSize} items...`);

  if (firstPageItems.length < PAGE_SIZE || fetched >= totalSize) {
    // Only one page needed
    return upToCeiling(mappedFirstPage);
  }

  // Calculate remaining page offsets
  const remainingOffsets = [];
  for (let offset = PAGE_SIZE; offset < totalSize; offset += PAGE_SIZE) {
    remainingOffsets.push(offset);
  }

  // Fetch remaining pages in parallel batches of PARALLEL_PAGES
  const allMappedItems = [...mappedFirstPage];

  for (let i = 0; i < remainingOffsets.length; i += PARALLEL_PAGES) {
    // Nobody waiting any more: stop before asking for more pages.
    signal.throwIfAborted();
    // The plan above already ends at the ceiling; this holds whatever the plan was.
    if (allMappedItems.length >= maxItems) break;
    const batch = remainingOffsets.slice(i, i + PARALLEL_PAGES);

    const batchResults = await Promise.all(
      batch.map(async (offset) => {
        const res = await fetchPage(offset);

        const data = await pageOf(res);
        return { offset, items: itemsOf(data.MediaContainer || {}) };
      })
    );

    // Sort by offset to maintain order, then append
    batchResults.sort((a, b) => a.offset - b.offset);

    for (const result of batchResults) {
      fetched += result.items.length;
      const mapped = result.items.map((item) => mapPlexItem(item, serverUri));
      allMappedItems.push(...mapped);
    }

    console.log(`  Fetched ${fetched}/${totalSize} items...`);
  }

  signal.throwIfAborted();
  // The last page may reach past the ceiling.
  return upToCeiling(allMappedItems);
}

/**
 * Get full details for a single item by ratingKey.
 * Includes complete cast/crew that may not be in the /all endpoint.
 */
export async function getItemDetails(serverUri, ratingKey, token) {
  const url = `${serverUri}/library/metadata/${plexId(ratingKey)}`;

  const res = await plexFetch(url, {
    headers: { Accept: 'application/json', 'X-Plex-Token': token },
    signal: AbortSignal.timeout(15_000),
    maxAnswerBytes: MAX_SMALL_ANSWER_BYTES,
  });

  if (!res.ok) {
    throw new Error(
      `Failed to get item details: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json();
  const item = data.MediaContainer?.Metadata?.[0];
  if (!item) return null;

  return {
    ratingKey: item.ratingKey,
    // Which library the item sits in, for isListedLibrary.
    librarySectionID: sectionOfItem(data),
    title: item.title,
    year: item.year,
    type: item.type,
    summary: item.summary,
    thumb: proxiedImageUrl(serverUri, item.thumb),
    genres: (item.Genre || []).map((g) => g.tag),
    duration: item.duration,
    contentRating: item.contentRating,
    originallyAvailableAt: item.originallyAvailableAt,
    audienceRating: item.audienceRating,
    rating: item.rating,
    studio: item.studio,
    actors: (item.Role || []).map((r) => r.tag),
    director: (item.Director || []).map((d) => d.tag).join(', ') || null,
    writers: (item.Writer || []).map((w) => w.tag),
    viewCount: item.viewCount || 0,
    viewOffset: item.viewOffset || null,
    addedAt: item.addedAt || null,
    lastViewedAt: item.lastViewedAt || null,
  };
}
