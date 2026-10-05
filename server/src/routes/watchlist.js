import { profileIdFrom } from '../profiles.js';
import { addToWatchlist, removeFromWatchlist, getWatchlist, markWatched, isOnWatchlist } from '../watchlist.js';
import { app } from '../app.js';

// ---------- Watchlist Routes ----------

/**
 * POST /api/watchlist
 * Add an item to the watchlist.
 */
app.post('/api/watchlist', (req, res) => {
  try {
    const item = req.body;
    if (!item || !item.title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const added = addToWatchlist(item, profileIdFrom(req));
    res.status(201).json({ item: added });
  } catch (err) {
    console.error('Error adding to watchlist:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/watchlist/:id
 * Remove an item from the watchlist.
 */
app.delete('/api/watchlist/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const removed = removeFromWatchlist(id, profileIdFrom(req));

    if (!removed) {
      return res.status(404).json({ error: 'Watchlist item not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing from watchlist:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/watchlist
 * Get the watchlist. Query: ?filter=unwatched|watched|all (default: all)
 */
app.get('/api/watchlist', (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const items = getWatchlist(filter, profileIdFrom(req));
    res.json({ items, count: items.length });
  } catch (err) {
    console.error('Error fetching watchlist:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/watchlist/:id/watched
 * Mark a watchlist item as watched.
 */
app.post('/api/watchlist/:id/watched', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const updated = markWatched(id, profileIdFrom(req));

    if (!updated) {
      return res.status(404).json({ error: 'Watchlist item not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error marking as watched:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/watchlist/check/:plexKey
 * Check if an item is on the watchlist.
 */
app.get('/api/watchlist/check/:plexKey', (req, res) => {
  try {
    const { plexKey } = req.params;
    const onList = isOnWatchlist(plexKey, profileIdFrom(req));
    res.json({ onWatchlist: onList });
  } catch (err) {
    console.error('Error checking watchlist:', err.message);
    res.status(500).json({ error: err.message });
  }
});
