import { getLibraryItems } from '../plex.js';
import { listLibraries } from '../plex-library.js';
import { enrichItems, applyCachedRatings } from '../ratings.js';
import { getCachedItems, setCachedItems } from '../library-cache.js';
import { shouldAttempt, getBackoffInfo, recordSuccess, recordFailure } from '../server-backoff.js';
import { app, enrichInBackground, ensureServers, getPlexToken } from '../app.js';
import { clientGone, libraryIsListed, refreshLibrary } from '../library-loader.js';

/**
 * GET /api/libraries
 * List all libraries across all accessible servers.
 * Each library includes a `serverStatus` field indicating health.
 */
app.get('/api/libraries', async (req, res) => {
  try {
    const token = getPlexToken();

    // Cached server discovery (TTL'd). Shared servers appearing/disappearing are
    // picked up within the TTL, or sooner via ?refresh=true (honored at most
    // once in 20 seconds, see ensureServers).
    const servers = await ensureServers(req.query.refresh === 'true');

    const allLibraries = [];
    const serverWarnings = [];

    // Fetch every server's libraries in parallel — one slow/remote server should
    // not serialize behind the others.
    await Promise.all(
      servers.map(async (server) => {
        // Ignore servers with no reachable connection (detected during discovery)
        // — don't spend the 15 second section-list time limit on a dead server.
        if (server.reachable === false) {
          serverWarnings.push({
            serverName: server.sourceTitle ? `${server.sourceTitle} / ${server.name}` : server.name,
            serverKey: server.clientIdentifier,
            error: 'no reachable connection',
            status: 'unreachable',
            secondsUntilRetry: null,
          });
          return;
        }
        // Skip servers currently in backoff window — don't even attempt the fetch.
        if (!shouldAttempt(server.clientIdentifier)) {
          const info = getBackoffInfo(server.clientIdentifier);
          serverWarnings.push({
            serverName: server.name,
            serverKey: server.clientIdentifier,
            error: info?.lastError || 'unreachable',
            status: 'backoff',
            secondsUntilRetry: info?.secondsUntilRetry || null,
          });
          return;
        }
        try {
          // listLibraries also notes these as the libraries that may be read.
          const libs = await listLibraries(server, server.accessToken || token);
          recordSuccess(server.clientIdentifier);
          const withServerName = libs.map((lib) => ({
            ...lib,
            serverName: server.sourceTitle ? `${server.sourceTitle} / ${server.name}` : server.name,
            serverKey: server.clientIdentifier,
            owned: server.owned,
            serverStatus: 'healthy',
          }));
          allLibraries.push(...withServerName);
        } catch (err) {
          recordFailure(server.clientIdentifier, err);
          const info = getBackoffInfo(server.clientIdentifier);
          console.warn(
            `Library fetch failed for ${server.name} (${info?.failures}x), next retry in ${info?.secondsUntilRetry}s: ${err.message}`
          );
          serverWarnings.push({
            serverName: server.name,
            serverKey: server.clientIdentifier,
            error: err.message,
            status: 'unreachable',
            secondsUntilRetry: info?.secondsUntilRetry || null,
          });
        }
      })
    );

    const response = { libraries: allLibraries };
    if (serverWarnings.length > 0) {
      response.warnings = serverWarnings;
    }
    res.json(response);
  } catch (err) {
    console.error('Error fetching libraries:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/library/:serverKey/:libraryKey
 * Get all items from a specific library, enriched with ratings.
 * Supports stale-while-revalidate: serves stale cache immediately and refreshes in background.
 */
app.get('/api/library/:serverKey/:libraryKey', async (req, res) => {
  // Fires if the device that asked goes away before its answer. Set up before
  // anything is awaited, so a device that leaves early is not missed.
  const gone = clientGone(res);
  try {
    const token = getPlexToken();
    const { serverKey, libraryKey } = req.params;
    const forceRefresh = req.query.refresh === 'true';

    // Only a library the app lists, decided before the stored copy is served
    // and before Plex is asked.
    if (!(await libraryIsListed(serverKey, libraryKey))) {
      return res.status(404).json({ error: 'Library not found' });
    }

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = getCachedItems(serverKey, libraryKey);
      if (cached) {
        if (!cached.stale) {
          // Fresh cache — serve directly
          console.log(`Serving ${cached.itemCount} items from cache for ${serverKey}:${libraryKey}`);
          return res.json({ items: cached.items, count: cached.itemCount, fromCache: true, cachedAt: cached.cachedAt });
        }

        // Stale cache — serve stale data immediately and refresh in background
        console.log(`Serving stale cache for ${serverKey}:${libraryKey}, triggering background refresh...`);
        res.json({ items: cached.items, count: cached.itemCount, fromCache: true, stale: true, cachedAt: cached.cachedAt });

        // Background refresh (fire and forget). refreshLibrary runs once per
        // library however many requests find the same stale copy, where each
        // of them used to start a full read of its own. The copy it stores
        // always has its ratings: this route once took a skipRatings flag that
        // stored the bare Plex items instead, and any device that may only
        // look could use it to wipe the ratings from what everyone is served.
        refreshLibrary(serverKey, libraryKey)
          .then((enriched) => {
            if (enriched) console.log(`Background refresh complete: ${enriched.length} items for ${serverKey}:${libraryKey}`);
          })
          .catch((bgErr) => {
            console.error(`Background refresh failed for ${serverKey}:${libraryKey}:`, bgErr.message);
          });

        return;
      }
    }

    // No cache — fetch fresh from Plex, return items immediately, enrich in the
    // background. Blocking on rate-limited rating enrichment is what made
    // uncached libraries appear to never load.
    const servers = await ensureServers();
    const server = servers.find(
      (s) => s.clientIdentifier === serverKey
    );
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    console.log(`Fetching library ${libraryKey} from ${server.name}...`);

    // Get items from Plex (with connection failover). Requests for the same
    // library at the same moment share one read, a forced re-read included,
    // and the read stops if every device waiting for it goes away.
    const items = await getLibraryItems(server.uri, libraryKey, server.accessToken || token, server.connections, { signal: gone });

    // Return raw items now so the grid renders (titles + Plex art); enrich ratings
    // in the background and cache the enriched result for next time.
    // Ratings already on file go out with this first answer. Without them a
    // fresh load showed a library with no ratings, rating filters emptied the
    // grid, and nothing on the page ever asked again once enrichment finished.
    // These bare items are never stored: the shared copy is only ever replaced
    // by the enriched one (enrichInBackground below), so a forced re-read
    // (refresh=true) cannot take the ratings away from what others are served.
    res.json({ items: applyCachedRatings(items), count: items.length, fromCache: false, enriching: true });
    enrichInBackground(serverKey, libraryKey, items);
    return;
  } catch (err) {
    // The device left before its answer: there is nobody to tell.
    if (gone.aborted) return;
    console.error('Error fetching library items:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cache/warm
 * One-time background job: fetch + enrich every currently-uncached library on
 * reachable servers so they load instantly afterward. Returns immediately;
 * poll GET /api/cache/warm/status for progress.
 */
let warmState = { running: false, warmed: 0, skipped: 0, failed: 0, total: 0, startedAt: null };
app.post('/api/cache/warm', (req, res) => {
  if (warmState.running) {
    return res.json({ status: 'already running', ...warmState });
  }
  warmState = { running: true, warmed: 0, skipped: 0, failed: 0, total: 0, startedAt: new Date().toISOString() };
  res.json({ status: 'started' });

  void (async () => {
    try {
      const token = getPlexToken();
      const servers = await ensureServers();
      for (const server of servers) {
        if (server.reachable === false || !shouldAttempt(server.clientIdentifier)) continue;
        let libs;
        try {
          libs = await listLibraries(server, server.accessToken || token);
        } catch (err) {
          console.warn(`Warm: cannot list libraries for ${server.name}: ${err.message}`);
          continue;
        }
        for (const lib of libs) {
          // Only warm libraries with no cache at all; stale ones already serve fine.
          if (getCachedItems(server.clientIdentifier, lib.key)) {
            warmState.skipped++;
            continue;
          }
          warmState.total++;
          try {
            const items = await getLibraryItems(server.uri, lib.key, server.accessToken || token, server.connections);
            const enriched = await enrichItems(items);
            setCachedItems(server.clientIdentifier, lib.key, enriched);
            warmState.warmed++;
            console.log(`Warm: cached ${server.name}/${lib.title} (${enriched.length} items) [${warmState.warmed} warmed]`);
          } catch (err) {
            warmState.failed++;
            console.warn(`Warm: failed ${server.name}/${lib.title}: ${err.message}`);
          }
        }
      }
      console.log(`Cache warm complete: ${warmState.warmed} warmed, ${warmState.skipped} already cached, ${warmState.failed} failed`);
    } catch (err) {
      console.error('Cache warm error:', err.message);
    } finally {
      warmState.running = false;
    }
  })();
});

app.get('/api/cache/warm/status', (req, res) => {
  res.json(warmState);
});
