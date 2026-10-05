// Keeps the library caches filled in the background.
//
// Two things depend on this. First, "do I already own this?" — the streaming
// browser can only answer that against libraries it has actually read, and a
// library nobody has opened yet is invisible. Second, first-open speed: the big
// shared Movies libraries take minutes to pull cold, which is a terrible way to
// greet someone who just wants to watch something.
//
// It walks libraries one at a time on purpose. These are other people's servers
// and hammering them with parallel full-library scans is both rude and a good
// way to get rate-limited.

import { getLibraryItems } from './plex.js';
import { listLibraries } from './plex-library.js';
import { getCachedItems, setCachedItems, isCacheStale } from './library-cache.js';
import { indexLibrary, pruneMissingServers, pruneUnlistedLibraries } from './corpus-index.js';
import { applyCachedRatings } from './ratings.js';

const PAUSE_BETWEEN_LIBRARIES_MS = 5000;

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  current: null,
  done: 0,
  total: 0,
  cached: 0,
  failed: 0,
};

export function warmerStatus() {
  return { ...state };
}

/**
 * Fill every library cache that is empty or stale.
 * @param {Function} getServers - returns the list of Plex servers
 * @param {string} token - account token, used when a server has no own token
 * @param {object} options - { force } to re-read even fresh caches
 */
export async function warmLibraries(getServers, token, options = {}) {
  if (state.running) return warmerStatus();

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.done = 0;
  state.total = 0;
  state.cached = 0;
  state.failed = 0;

  try {
    // Enumerating 40-odd libraries across four servers takes a while on its
    // own. Say so, otherwise the status reads "0 of 0" and looks stalled.
    state.current = 'finding libraries';

    const servers = await getServers();
    const targets = [];

    // A server that is no longer shared with us takes its titles with it.
    if (servers.length > 0) pruneMissingServers(servers.map((s) => s.clientIdentifier));

    for (const server of servers) {
      try {
        // listLibraries also notes these as the libraries that may be read.
        const libs = await listLibraries(server, server.accessToken || token);
        // A library the server no longer lists takes its titles with it.
        try {
          pruneUnlistedLibraries(server.clientIdentifier, libs.map((lib) => lib.key));
        } catch (err) {
          // Not a reason to skip warming this server.
          console.error(`[warmer] could not clear the titles of libraries ${server.name} no longer lists: ${err.message}`);
        }
        for (const lib of libs) {
          targets.push({ server, lib });
        }
      } catch {
        // Offline server: nothing to warm, and it is already reported elsewhere.
      }
    }

    state.total = targets.length;

    for (const { server, lib } of targets) {
      const serverKey = server.clientIdentifier;

      const cached = getCachedItems(serverKey, lib.key);
      const needsRead = options.force || !cached || isCacheStale(serverKey, lib.key);
      if (!needsRead) {
        state.done += 1;
        continue;
      }

      state.current = `${server.name} / ${lib.title}`;

      try {
        const items = await getLibraryItems(
          server.uri,
          lib.key,
          server.accessToken || token,
          server.connections
        );
        if (items && items.length) {
          // Ratings on file are merged in first: the library view serves this
          // cache as it is, and a cache without them showed a library with
          // every rating gone.
          setCachedItems(serverKey, lib.key, applyCachedRatings(items));
          // Index as we go: the searchable copy is what every recommendation
          // surface reads, and it must not depend on anything staying in RAM.
          indexLibrary(serverKey, lib.key, items);
          state.cached += 1;
          console.log(`[warmer] cached ${items.length} items from ${server.name} / ${lib.title}`);
        }
      } catch (err) {
        state.failed += 1;
        console.error(`[warmer] failed ${server.name} / ${lib.title}: ${err.message}`);
      }

      state.done += 1;
      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_LIBRARIES_MS));
    }
  } catch (err) {
    console.error('[warmer] aborted:', err.message);
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = new Date().toISOString();
    console.log(
      `[warmer] finished: ${state.cached} libraries refreshed, ${state.failed} failed, ${state.total} seen`
    );
  }

  return warmerStatus();
}
