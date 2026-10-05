import { getTmdbSimilar } from '../ratings.js';
import { getCast, getTrailerKey } from '../tmdb-extras.js';
import { invalidateCache, invalidateAllCaches } from '../library-cache.js';
import { matchExternal } from '../corpus-index.js';
import { app } from '../app.js';
import { loadOrFetchLibrary } from '../library-loader.js';

/**
 * GET /api/actors
 * Get unique actors from a specific library, deduped and sorted alphabetically.
 * Query params: serverKey, libraryKey
 */
app.get('/api/actors', async (req, res) => {
  try {
    const { serverKey, libraryKey } = req.query;

    if (!serverKey || !libraryKey) {
      return res.status(400).json({ error: 'serverKey and libraryKey are required' });
    }
    // The stored copy of the library, or one shared read when there is none.
    // This used to read the whole library from Plex on every request. Null
    // means it is not a library the app lists (or its server is gone).
    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) {
      return res.status(404).json({ error: 'Library not found' });
    }
    const actorSet = new Set();
    for (const item of items) {
      if (item.actors) {
        item.actors.forEach((a) => actorSet.add(a));
      }
    }

    const actors = [...actorSet].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
    res.json({ actors, count: actors.length });
  } catch (err) {
    console.error('Error fetching actors:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/directors
 * Get unique directors from a specific library, deduped and sorted alphabetically.
 * Query params: serverKey, libraryKey
 */
app.get('/api/directors', async (req, res) => {
  try {
    const { serverKey, libraryKey } = req.query;

    if (!serverKey || !libraryKey) {
      return res.status(400).json({ error: 'serverKey and libraryKey are required' });
    }
    // The stored copy of the library, or one shared read when there is none.
    // This used to read the whole library from Plex on every request. Null
    // means it is not a library the app lists (or its server is gone).
    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) {
      return res.status(404).json({ error: 'Library not found' });
    }
    const directorSet = new Set();
    for (const item of items) {
      if (item.director) {
        // director is a comma-separated string; split into individual names
        item.director.split(',').forEach((d) => {
          const trimmed = d.trim();
          if (trimmed) directorSet.add(trimmed);
        });
      }
    }

    const directors = [...directorSet].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
    res.json({ directors, count: directors.length });
  } catch (err) {
    console.error('Error fetching directors:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/similar/:tmdbId
 * Find similar titles using TMDB recommendations, cross-referenced with user's Plex library.
 * Query params: type ('movie' | 'show'), serverKey, libraryKey
 */
// A TMDB id as the app writes it: a plain whole number above zero, of at most
// ten digits. Every different id that reaches the lookup costs one request to
// TMDB and can store one row, and "-5", "7junk" and a number of twenty-three
// digits each used to count as a new one.
function tmdbIdFrom(raw) {
  return /^[1-9]\d{0,9}$/.test(String(raw)) ? Number(raw) : null;
}

app.get('/api/cast/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const id = tmdbIdFrom(tmdbId);
    if (id === null) return res.status(400).json({ error: 'That is not a TMDB id' });
    const cast = await getCast(type, id);
    res.json({ cast });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trailer/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const id = tmdbIdFrom(tmdbId);
    if (id === null) return res.status(400).json({ error: 'That is not a TMDB id' });
    const key = await getTrailerKey(type, id);
    res.json({ key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/similar/:tmdbId
 * TMDB's recommendations for a title, split into ones you already have and
 * ones to discover. "Already have" is answered by the search index (every
 * library, kept up to date in the background), matched by TMDB id first. It
 * used to download every library from every server live on each request,
 * which took minutes and could push the server towards its memory limit.
 */
app.get('/api/similar/:tmdbId', async (req, res) => {
  try {
    const { tmdbId } = req.params;
    const { type = 'movie' } = req.query;
    const mediaType = type === 'show' || type === 'tv' ? 'tv' : 'movie';

    const similar = await getTmdbSimilar(parseInt(tmdbId, 10), type);
    if (similar.length === 0) {
      return res.json({ similar: [], inLibrary: [], notInLibrary: [] });
    }

    const owned = matchExternal(similar.map((rec) => ({ ...rec, type: mediaType })));
    const inLibrary = [];
    const notInLibrary = [];
    for (const rec of similar) {
      const plexItem = owned.get(`${mediaType}:${rec.tmdbId}`);
      if (plexItem) inLibrary.push({ ...rec, inPlex: true, plexItem });
      else notInLibrary.push({ ...rec, inPlex: false });
    }

    // In-library first by rating, then the rest by rating
    inLibrary.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    notInLibrary.sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.json({ similar: [...inLibrary, ...notInLibrary], inLibrary, notInLibrary });
  } catch (err) {
    console.error('Error finding similar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cache/clear
 * Clear all cached library data.
 * Query params: serverKey, libraryKey (optional — if omitted, clears all)
 */
app.post('/api/cache/clear', (req, res) => {
  try {
    const { serverKey, libraryKey } = req.body || {};
    if (serverKey && libraryKey) {
      invalidateCache(serverKey, libraryKey);
      res.json({ success: true, message: `Cache cleared for ${serverKey}:${libraryKey}` });
    } else {
      invalidateAllCaches();
      res.json({ success: true, message: 'All caches cleared' });
    }
  } catch (err) {
    console.error('Error clearing cache:', err.message);
    res.status(500).json({ error: err.message });
  }
});
