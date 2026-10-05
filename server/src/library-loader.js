import { getLibraryItems } from './plex.js';
import { isListedLibrary, isRememberedLibrary } from './plex-library.js';
import { enrichItems } from './ratings.js';
import { getCachedItems, setCachedItems } from './library-cache.js';
import { ensureServers, getPlexToken } from './app.js';

/**
 * Is this a library the app lists (a movie or show library of a server the
 * account can reach)? Every route that takes a library from the request asks
 * this first and answers 404 "Library not found" for a no, before a stored
 * copy is served and before Plex is asked with the server's token. Without it
 * a request could name any section number, a photo or music section included.
 *
 * A library already on the list passes without the server list or the
 * network, so stored libraries keep working while plex.tv or the server is
 * unreachable.
 */
export async function libraryIsListed(serverKey, libraryKey) {
  if (isRememberedLibrary(serverKey, libraryKey)) return true;
  const servers = await ensureServers();
  const server = servers.find((s) => s.clientIdentifier === serverKey);
  if (!server) return false;
  return isListedLibrary(server, libraryKey, server.accessToken || getPlexToken());
}

// ---------- Helper: load cached library items for a serverKey/libraryKey ----------

export function loadCachedLibrary(serverKey, libraryKey) {
  const cached = getCachedItems(serverKey, libraryKey);
  if (!cached) return null;
  return cached.items;
}

// Libraries currently being read, rated and stored, so that asking for one
// twice waits for the first answer instead of doing all of that again.
const librariesInFlight = new Map();

/**
 * Read a library from Plex, add its ratings and store it. Callers asking for
 * the same library meanwhile wait on the same work. Null when the library is
 * not one the app lists or its server is not known.
 *
 * The read itself is also shared and limited one level down, in
 * getLibraryItems; this adds the rating lookups and the write to that.
 */
export async function refreshLibrary(serverKey, libraryKey) {
  // Picking a library fires four requests at once: the main one, plus three
  // discovery rows. On a cold cache all four looked, all four saw nothing, and
  // all four downloaded and enriched the same enormous library at the same
  // time. That is four times the work and four times the memory for one
  // answer, and it was a real part of what pushed this process into its memory
  // ceiling. The first caller now does the work and the rest wait on it.
  const key = `${serverKey}:${libraryKey}`;
  const existing = librariesInFlight.get(key);
  if (existing) return existing;

  const work = (async () => {
    if (!(await libraryIsListed(serverKey, libraryKey))) return null;
    const token = getPlexToken();
    const servers = await ensureServers();
    const server = servers.find((s) => s.clientIdentifier === serverKey);
    if (!server) return null;

    const items = await getLibraryItems(server.uri, libraryKey, server.accessToken || token, server.connections);
    const enriched = await enrichItems(items);
    setCachedItems(serverKey, libraryKey, enriched);
    return enriched;
  })();

  librariesInFlight.set(key, work);
  try {
    return await work;
  } finally {
    // Cleared whether it worked or not, so a failure does not poison every
    // later attempt with the same rejected promise.
    librariesInFlight.delete(key);
  }
}

/**
 * The stored copy of a library, or a fresh read when there is none. Every
 * route that only needs the titles uses this, so none of them reads a library
 * from Plex on each request.
 */
export async function loadOrFetchLibrary(serverKey, libraryKey) {
  // Only a library the app lists. Callers already answer 404 for null.
  if (!(await libraryIsListed(serverKey, libraryKey))) return null;

  const cached = getCachedItems(serverKey, libraryKey);
  if (cached) return cached.items;

  return refreshLibrary(serverKey, libraryKey);
}

/**
 * A signal that fires when the device that asked has gone away before its
 * answer was sent. Passed to getLibraryItems, so a read nobody is waiting for
 * is stopped instead of running on for minutes.
 */
export function clientGone(res) {
  const controller = new AbortController();
  // "close" also comes after an answer that was sent in full; only a
  // connection that closes before then means the device left.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
