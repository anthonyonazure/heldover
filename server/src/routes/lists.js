import { profileIdFrom } from '../profiles.js';
import { addToQueue, removeFromQueue, getQueue, reorderQueue, isInQueue } from '../watch-later.js';
import { rateItem, removeRating, getInsights, getRating, getAllRatings } from '../personal-ratings.js';
import { app, getPlexToken } from '../app.js';
import { getClientId } from '../config.js';
import { failureText } from '../plex-connections.js';
import { readJsonWithin } from '../plex-fetch.js';

// A watchlist answer from plex.tv is small; the limit is the same one the rest
// of the app puts on small answers.
const PLEX_TV_ANSWER_BYTES = 8 * 1024 * 1024;

// ---------- Plex Watchlist (Cloud Sync) Routes ----------

/**
 * A request to plex.tv's watchlist service. The token goes as a header, so no
 * address holds it, and a failure comes back in safe words: fetch quotes a
 * header value it cannot send, and the routes below hand their error text to
 * the browser.
 */
async function watchlistFetch(url, token, options = {}) {
  let failure;
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', ...options.headers, 'X-Plex-Token': token },
    });
  } catch (err) {
    failure = failureText(err);
  }
  throw new Error(`Could not reach plex.tv: ${failure}`);
}

/**
 * POST /api/plex-watchlist/add
 * Add an item to the Plex cloud watchlist.
 */
app.post('/api/plex-watchlist/add', async (req, res) => {
  try {
    const token = getPlexToken();
    const { guid } = req.body;
    if (!guid) {
      return res.status(400).json({ error: 'guid is required' });
    }

    const plexRes = await watchlistFetch(
      `https://discover.provider.plex.tv/actions/addToWatchlist?ratingKey=${encodeURIComponent(guid)}`,
      token,
      { method: 'PUT', headers: { 'X-Plex-Client-Identifier': getClientId() } }
    );

    if (!plexRes.ok) {
      const text = await plexRes.text().catch(() => '');
      return res.status(plexRes.status).json({ error: `Plex API error: ${plexRes.status}`, details: text });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error adding to Plex watchlist:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/plex-watchlist/remove
 * Remove an item from the Plex cloud watchlist.
 */
app.post('/api/plex-watchlist/remove', async (req, res) => {
  try {
    const token = getPlexToken();
    const { guid } = req.body;
    if (!guid) {
      return res.status(400).json({ error: 'guid is required' });
    }

    const plexRes = await watchlistFetch(
      `https://discover.provider.plex.tv/actions/removeFromWatchlist?ratingKey=${encodeURIComponent(guid)}`,
      token,
      { method: 'PUT', headers: { 'X-Plex-Client-Identifier': getClientId() } }
    );

    if (!plexRes.ok) {
      const text = await plexRes.text().catch(() => '');
      return res.status(plexRes.status).json({ error: `Plex API error: ${plexRes.status}`, details: text });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing from Plex watchlist:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/plex-watchlist
 * Get all items on the Plex cloud watchlist.
 */
app.get('/api/plex-watchlist', async (req, res) => {
  try {
    const token = getPlexToken();

    const plexRes = await watchlistFetch(
      `https://discover.provider.plex.tv/library/sections/watchlist/all?X-Plex-Client-Identifier=${encodeURIComponent(getClientId())}`,
      token
    );

    if (!plexRes.ok) {
      const text = await plexRes.text().catch(() => '');
      return res.status(plexRes.status).json({ error: `Plex API error: ${plexRes.status}`, details: text });
    }

    const data = await readJsonWithin(plexRes, PLEX_TV_ANSWER_BYTES);
    const items = (data.MediaContainer?.Metadata || []).map((item) => ({
      title: item.title,
      year: item.year,
      thumb: item.thumb || null,
      guid: item.guid || null,
      type: item.type,
      ratingKey: item.ratingKey,
    }));

    res.json({ items, count: items.length });
  } catch (err) {
    console.error('Error fetching Plex watchlist:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Watch Later Queue Routes ----------

/**
 * POST /api/queue
 * Add an item to the watch later queue.
 */
app.post('/api/queue', (req, res) => {
  try {
    const item = req.body;
    if (!item || !item.title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const added = addToQueue(item, profileIdFrom(req));
    res.status(201).json({ item: added });
  } catch (err) {
    console.error('Error adding to queue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/queue/:id
 * Remove an item from the watch later queue.
 */
app.delete('/api/queue/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const removed = removeFromQueue(id, profileIdFrom(req));

    if (!removed) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing from queue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/queue
 * Get the full watch later queue.
 */
app.get('/api/queue', (req, res) => {
  try {
    const items = getQueue(profileIdFrom(req));
    res.json({ items, count: items.length });
  } catch (err) {
    console.error('Error fetching queue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/queue/:id/reorder
 * Move a queue item to a new position.
 */
app.put('/api/queue/:id/reorder', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { position } = req.body;

    if (position == null || position < 0) {
      return res.status(400).json({ error: 'position is required and must be >= 0' });
    }

    const success = reorderQueue(id, position, profileIdFrom(req));
    if (!success) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering queue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/queue/check/:plexKey
 * Check if an item is in the watch later queue.
 */
app.get('/api/queue/check/:plexKey', (req, res) => {
  try {
    const { plexKey } = req.params;
    const inQueue = isInQueue(plexKey, profileIdFrom(req));
    res.json({ inQueue });
  } catch (err) {
    console.error('Error checking queue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Personal Ratings Routes ----------

// A rating key is only unique inside one Plex server, so these routes take the
// item's serverKey too. A request without one (a page loaded before this was
// added) reads and writes the rows that have no server, as it always did.

/** The item a rating request is about: the key from the path, the rest from the query. */
function itemFromQuery(req) {
  const { title, year } = req.query;
  return {
    plex_key: req.params.plexKey,
    title: typeof title === 'string' ? title : undefined,
    year: typeof year === 'string' && year ? Number(year) : undefined,
  };
}

/**
 * POST /api/ratings/personal
 * Rate an item thumbs up or down.
 */
app.post('/api/ratings/personal', (req, res) => {
  try {
    const { plexKey, serverKey, title, year, type, guid, genres, rating } = req.body;

    if (!plexKey || !title || !rating) {
      return res.status(400).json({ error: 'plexKey, title, and rating are required' });
    }

    const result = rateItem({ plex_key: plexKey, serverKey, title, year, type, guid, genres }, rating, profileIdFrom(req));
    res.json({ rating: result });
  } catch (err) {
    console.error('Error rating item:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/ratings/personal/:plexKey
 * Remove a personal rating. Query: ?serverKey=&title=&year=
 */
app.delete('/api/ratings/personal/:plexKey', (req, res) => {
  try {
    const removed = removeRating(itemFromQuery(req), profileIdFrom(req), req.query.serverKey);

    if (!removed) {
      return res.status(404).json({ error: 'Rating not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing rating:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ratings/personal/insights
 * Get personal rating insights (liked/disliked genres, counts).
 * NOTE: This route must be defined BEFORE /api/ratings/personal/:plexKey
 */
app.get('/api/ratings/personal/insights', (req, res) => {
  try {
    const insights = getInsights(profileIdFrom(req));
    res.json(insights);
  } catch (err) {
    console.error('Error fetching insights:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ratings/personal/:plexKey
 * Get the personal rating for a specific item. Query: ?serverKey=&title=&year=
 */
app.get('/api/ratings/personal/:plexKey', (req, res) => {
  try {
    const rating = getRating(itemFromQuery(req), profileIdFrom(req), req.query.serverKey);
    res.json({ rating });
  } catch (err) {
    console.error('Error fetching rating:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ratings/personal
 * Get all personal ratings. Query: ?filter=up|down|all
 */
app.get('/api/ratings/personal', (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const ratings = getAllRatings(filter, profileIdFrom(req));
    res.json({ ratings, count: ratings.length });
  } catch (err) {
    console.error('Error fetching ratings:', err.message);
    res.status(500).json({ error: err.message });
  }
});
