import { profileIdFrom } from '../profiles.js';
import { getMoods, getMoodById } from '../mood-presets.js';
import { pickTonight } from '../tonight.js';
import { markNotInterested, unmarkNotInterested, listNotInterested } from '../feedback.js';
import { createCuratedView, listCuratedViews, getCuratedView, updateCuratedView, deleteCuratedView, EditPinError, ViewInputError } from '../curated-views.js';
import { guessWait, recordWrongGuess, recordRightGuess } from '../auth.js';
import { app, clampCount } from '../app.js';
import { loadOrFetchLibrary } from '../library-loader.js';

// ---------- Tonight Mode + Moods ----------

app.get('/api/moods', (req, res) => {
  try {
    res.json({ moods: getMoods() });
  } catch (err) {
    console.error('Error listing moods:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tonight', async (req, res) => {
  try {
    const { serverKey, libraryKey, mood = 'funny' } = req.query;
    const count = clampCount(req.query.count, 5, 20);
    if (!serverKey || !libraryKey) return res.status(400).json({ error: 'serverKey and libraryKey are required' });
    if (!getMoodById(mood)) return res.status(400).json({ error: `Unknown mood: ${mood}` });

    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) return res.status(404).json({ error: 'Library not found' });

    const picks = pickTonight({ items, serverKey, moodId: mood, count, includeWatched: req.query.includeWatched === 'true', profileId: profileIdFrom(req) });
    res.json({ mood, items: picks, count: picks.length });
  } catch (err) {
    console.error('Error picking tonight:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Feedback (Not Interested) ----------
//
// The body carries the item's serverKey, because a rating key is only unique
// inside one Plex server. A request without one (a page loaded before this was
// added) reads and writes the rows that have no server, as it always did.

app.post('/api/feedback/not-interested', (req, res) => {
  try {
    const item = req.body;
    if (!item) return res.status(400).json({ error: 'body is required' });
    const result = markNotInterested(item, profileIdFrom(req));
    res.status(201).json(result);
  } catch (err) {
    console.error('Error marking not-interested:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/feedback/not-interested/:plexKey', (req, res) => {
  try {
    // Query: ?serverKey=&title=&year=
    const { serverKey, title, year } = req.query;
    const item = {
      plex_key: req.params.plexKey,
      title: typeof title === 'string' ? title : undefined,
      year: typeof year === 'string' && year ? Number(year) : undefined,
    };
    const removed = unmarkNotInterested(item, profileIdFrom(req), serverKey);
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error unmarking not-interested:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/feedback/not-interested', (req, res) => {
  try {
    res.json({ items: listNotInterested(profileIdFrom(req)) });
  } catch (err) {
    console.error('Error listing not-interested:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Curated Views ----------

app.post('/api/views', (req, res) => {
  try {
    const { name, description, filters, serverKey, libraryKey, editPin } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const view = createCuratedView({ name, description, filters, serverKey, libraryKey, editPin });
    res.status(201).json({ view });
  } catch (err) {
    if (err instanceof ViewInputError) return res.status(400).json({ error: err.message });
    console.error('Error creating view:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/views', (req, res) => {
  try {
    res.json({ views: listCuratedViews() });
  } catch (err) {
    console.error('Error listing views:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/views/:slug', (req, res) => {
  try {
    const view = getCuratedView(req.params.slug);
    if (!view) return res.status(404).json({ error: 'View not found' });
    res.json({ view });
  } catch (err) {
    console.error('Error getting view:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/views/:slug/items', async (req, res) => {
  try {
    const view = getCuratedView(req.params.slug);
    if (!view) return res.status(404).json({ error: 'View not found' });
    if (!view.server_key || !view.library_key) {
      return res.status(400).json({ error: 'View has no server/library bound' });
    }
    const items = await loadOrFetchLibrary(view.server_key, view.library_key);
    if (!items) return res.status(404).json({ error: 'Library not available' });
    const { applyFilters } = await import('../filters.js');
    const filtered = applyFilters(items, view.filters || {});
    res.json({ view, items: filtered, count: filtered.length });
  } catch (err) {
    console.error('Error rendering view:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Changing or deleting a view that is locked with an edit PIN.
 *
 * Wrong guesses are counted the way wrong tries at the access PIN are (the
 * same counters in auth.js): five from one address and it waits five minutes,
 * and while it waits even the right PIN is not looked at. Before this the PIN
 * could be tried as fast as requests could be sent, and a short one fell in
 * seconds. Asking without any PIN is refused but is not a guess.
 *
 * The PIN is read from the body only. In the address it would be written to
 * proxy logs and browser history, so that form is refused outright, whether
 * the PIN in it is right or wrong.
 *
 * `change` does the work and returns what to send back; a view that is not
 * locked goes straight through.
 */
function changeLockedView(req, res, what, change) {
  try {
    if (req.query.editPin !== undefined) {
      return res.status(400).json({ error: 'Send the edit PIN in the body of the request, not in the address.' });
    }
    const view = getCuratedView(req.params.slug);
    if (!view) return res.status(404).json({ error: 'View not found' });
    if (view.has_pin) {
      const wait = guessWait(req);
      if (wait) return res.status(429).json({ error: `Too many wrong tries. Try again in ${wait} seconds.` });
    }
    const answer = change();
    if (!answer) return res.status(404).json({ error: 'View not found' });
    if (view.has_pin) recordRightGuess(req);
    res.json(answer);
  } catch (err) {
    if (err instanceof EditPinError) {
      if (err.guessed) recordWrongGuess(req);
      return res.status(403).json({ error: err.message, editPinRequired: true });
    }
    console.error(`Error ${what} view:`, err.message);
    res.status(500).json({ error: err.message });
  }
}

app.put('/api/views/:slug', (req, res) => {
  changeLockedView(req, res, 'updating', () => {
    const updated = updateCuratedView(req.params.slug, req.body || {});
    return updated && { view: updated };
  });
});

app.delete('/api/views/:slug', (req, res) => {
  changeLockedView(req, res, 'deleting', () => {
    const removed = deleteCuratedView(req.params.slug, req.body?.editPin);
    return removed && { success: true };
  });
});
