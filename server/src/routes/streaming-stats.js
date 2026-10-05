import { getLibraryItems } from '../plex.js';
import { listLibraries } from '../plex-library.js';
import { applyFilters } from '../filters.js';
import { getCachedItems } from '../library-cache.js';
import { getTrending } from '../trending.js';
import { PROVIDERS, getAvailability, getAvailabilityBatch, discoverByProvider, watchUrlFor } from '../availability.js';
import { getLibraryStats } from '../stats.js';
import { findDuplicates } from '../duplicates.js';
import { app, ensureServers, getPlexToken } from '../app.js';
import { clientGone, libraryIsListed, loadOrFetchLibrary } from '../library-loader.js';

// ---------- Trending, Stats, Duplicates, Random, Trailers ----------

/**
 * GET /api/trending
 * Get trending titles from TMDB.
 * Query: ?type=movie|tv&window=day|week (defaults: movie, week)
 */
app.get('/api/trending', async (req, res) => {
  try {
    const type = req.query.type || 'movie';
    const window = req.query.window || 'week';
    const trending = await getTrending(type, window);
    res.json({ trending, count: trending.length });
  } catch (err) {
    console.error('Error fetching trending:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/providers
 * The streaming services we show badges and browse rows for.
 */
app.get('/api/providers', (req, res) => {
  res.json({
    providers: PROVIDERS.map(({ id, name, slug, color }) => ({ id, name, slug, color })),
  });
});

/**
 * GET /api/availability/:type/:tmdbId
 * Where one title streams, rents, and sells. type is movie|show|tv.
 */
app.get('/api/availability/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const region = req.query.region || 'US';
    const availability = await getAvailability(type, tmdbId, region);
    res.json(availability);
  } catch (err) {
    console.error('Error fetching availability:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/availability/batch
 * Body: { items: [{ tmdbId, type }], region }
 * One call for a whole grid, so scrolling does not fan out into dozens of
 * requests. Returns a map keyed `<movie|tv>:<tmdbId>`.
 */
app.post('/api/availability/batch', async (req, res) => {
  try {
    const { items, region } = req.body || {};
    const availability = await getAvailabilityBatch(items || [], region || 'US');
    res.json({ availability, count: Object.keys(availability).length });
  } catch (err) {
    console.error('Error fetching availability batch:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/streaming/:provider
 * What is on a service right now. provider is a slug (netflix) or TMDB id (8).
 * Query: type=movie|tv, page, sortBy, minRating, minVotes, genre, region.
 */
app.get('/api/streaming/:provider', async (req, res) => {
  try {
    const payload = await discoverByProvider(req.params.provider, {
      type: req.query.type,
      page: req.query.page,
      sortBy: req.query.sortBy,
      minRating: req.query.minRating,
      minVotes: req.query.minVotes,
      genre: req.query.genre,
      region: req.query.region,
    });
    res.json(payload);
  } catch (err) {
    console.error('Error browsing provider:', err.message);
    const status = /Unknown provider/.test(err.message) ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/watch-url/:provider
 * Pre-filled search link into a service's own app. Query: ?title=...
 */
app.get('/api/watch-url/:provider', (req, res) => {
  const url = watchUrlFor(req.params.provider, req.query.title);
  if (!url) return res.status(404).json({ error: 'Unknown provider' });
  res.json({ url });
});

/**
 * GET /api/stats/:serverKey/:libraryKey
 * Get statistics for a specific library.
 */
app.get('/api/stats/:serverKey/:libraryKey', async (req, res) => {
  try {
    const { serverKey, libraryKey } = req.params;

    // Only a library the app lists, decided before the stored copy is read.
    if (!(await libraryIsListed(serverKey, libraryKey))) {
      return res.status(404).json({ error: 'Library not found' });
    }

    // Try to use cached items first
    const cached = getCachedItems(serverKey, libraryKey);
    if (cached) {
      const stats = getLibraryStats(cached.items);
      return res.json({ stats, fromCache: true, stale: cached.stale || false });
    }

    // Nothing stored yet: read, rate and store it, through the one loader
    // that makes requests arriving together share that work.
    const enriched = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!enriched) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const stats = getLibraryStats(enriched);
    res.json({ stats, fromCache: false });
  } catch (err) {
    console.error('Error computing stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/duplicates
 * Find duplicate titles across all libraries.
 */
app.get('/api/duplicates', async (req, res) => {
  // One request here can read every library that is not stored yet. If the
  // device that asked goes away, the walk stops and so does the read in hand.
  const gone = clientGone(res);
  try {
    const token = getPlexToken();
    const servers = await ensureServers();

    const allItems = [];
    for (const server of servers) {
      if (gone.aborted) return;
      try {
        const libs = await listLibraries(server, server.accessToken || token);
        for (const lib of libs) {
          if (gone.aborted) return;
          try {
            // Try cache first
            const cached = getCachedItems(server.clientIdentifier, lib.key);
            let items;
            if (cached) {
              items = cached.items;
            } else {
              items = await getLibraryItems(server.uri, lib.key, server.accessToken || token, server.connections, { signal: gone });
            }

            const withSource = items.map((item) => ({
              ...item,
              serverName: server.name,
              serverKey: server.clientIdentifier,
              libraryTitle: lib.title,
              libraryKey: lib.key,
            }));
            allItems.push(...withSource);
          } catch (err) {
            console.error(`Error fetching items from ${server.name}/${lib.title}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`Error fetching libraries from ${server.name}:`, err.message);
      }
    }

    const duplicates = findDuplicates(allItems);
    res.json({ duplicates, totalGroups: duplicates.length });
  } catch (err) {
    if (gone.aborted) return;
    console.error('Error finding duplicates:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/random/:serverKey/:libraryKey
 * Get a random item from a library with optional filters applied.
 * Query params: same as /api/search
 */
app.get('/api/random/:serverKey/:libraryKey', async (req, res) => {
  try {
    const { serverKey, libraryKey } = req.params;

    // Only a library the app lists, decided before the stored copy is read.
    if (!(await libraryIsListed(serverKey, libraryKey))) {
      return res.status(404).json({ error: 'Library not found' });
    }

    // The stored copy, or one shared read when there is none yet.
    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Apply filters from query params
    const {
      search, type, minRating, minTmdbRating, minRottenTomatoes,
      genres, excludeGenres, excludeContentRatings,
      actor, director, minRuntime, maxRuntime,
      releasedAfter, releasedBefore, excludeWatched,
      yearFrom, yearTo,
    } = req.query;

    const filters = {
      search, type, minRating, minTmdbRating, minRottenTomatoes,
      genres: genres ? genres.split(',').map((g) => g.trim()) : undefined,
      excludeGenres: excludeGenres ? excludeGenres.split(',').map((g) => g.trim()) : undefined,
      excludeContentRatings: excludeContentRatings ? excludeContentRatings.split(',').map((r) => r.trim()) : undefined,
      actor, director, minRuntime, maxRuntime,
      releasedAfter, releasedBefore,
      excludeWatched: excludeWatched === 'true',
      yearFrom, yearTo,
    };

    const filtered = applyFilters(items, filters);

    if (filtered.length === 0) {
      return res.json({ item: null, message: 'No items match the given filters' });
    }

    const randomIndex = Math.floor(Math.random() * filtered.length);
    res.json({ item: filtered[randomIndex], totalMatching: filtered.length });
  } catch (err) {
    console.error('Error getting random item:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/trailers/:tmdbId
 * Get YouTube trailer URL from TMDB videos endpoint.
 * Query: ?type=movie|tv (default: movie)
 */
app.get('/api/trailers/:tmdbId', async (req, res) => {
  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'TMDB_API_KEY not configured' });
    }

    const { tmdbId } = req.params;
    const type = req.query.type || 'movie';
    const mediaType = type === 'show' || type === 'tv' ? 'tv' : 'movie';

    const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/videos?api_key=${apiKey}`;
    const tmdbRes = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!tmdbRes.ok) {
      return res.status(tmdbRes.status).json({ error: `TMDB API error: ${tmdbRes.status}` });
    }

    const data = await tmdbRes.json();
    const videos = data.results || [];

    // Find the first YouTube trailer
    const trailer = videos.find(
      (v) => v.type === 'Trailer' && v.site === 'YouTube'
    );

    if (!trailer) {
      // Fall back to any YouTube video (teaser, clip, etc.)
      const anyYoutube = videos.find((v) => v.site === 'YouTube');
      if (anyYoutube) {
        return res.json({
          trailerUrl: `https://www.youtube.com/watch?v=${anyYoutube.key}`,
          name: anyYoutube.name,
          type: anyYoutube.type,
        });
      }
      return res.json({ trailerUrl: null, message: 'No trailer found' });
    }

    res.json({
      trailerUrl: `https://www.youtube.com/watch?v=${trailer.key}`,
      name: trailer.name,
      type: trailer.type,
    });
  } catch (err) {
    console.error('Error fetching trailer:', err.message);
    res.status(500).json({ error: err.message });
  }
});
