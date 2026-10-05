import { getAllServerStatuses, checkAllServersShared, getNewAdditions, getMatchingNewAdditions, saveCriteria, getSavedCriteria, deleteCriteria } from '../monitor.js';
import { app, ensureServers, getPlexToken } from '../app.js';
import { warmPostersFor, withExternalIds } from './servers-posters.js';

// ---------- Server Status & Monitoring Routes ----------

/**
 * GET /api/status
 * Returns server health status for all known servers.
 */
app.get('/api/status', (req, res) => {
  try {
    const statuses = getAllServerStatuses();
    res.json({ statuses });
  } catch (err) {
    console.error('Error fetching server status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// A check that ended less than this long ago is the answer to the next
// request. A round over three servers takes under a second when they answer
// and up to 8 seconds for each one that does not, and the status bar asks for
// the stored status every 30 seconds, so nobody waits on this. It is counted
// from the end of a round, so a slow round is not started again at once.
const RECHECK_MIN_INTERVAL_MS = 15_000;

/**
 * POST /api/status/check
 * Re-check all servers now.
 *
 * Open to every device that may look (the Re-check control is shown to all of
 * them), so it is shared and limited instead of guarded: requests that arrive
 * together get one round of probes between them, and a request within
 * RECHECK_MIN_INTERVAL_MS of the last round gets that round's answer at once.
 */
app.post('/api/status/check', async (req, res) => {
  try {
    const token = getPlexToken();
    const results = await checkAllServersShared(ensureServers, token, { minIntervalMs: RECHECK_MIN_INTERVAL_MS });
    res.json({ statuses: results });
  } catch (err) {
    console.error('Error checking server status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/new-additions
 * Get items added in last N days.
 * Query params: days (default 7, at most 30: older rows are not kept)
 */
app.get('/api/new-additions', (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 7;
    const limit = parseInt(req.query.limit, 10) || undefined;
    const additions = withExternalIds(getNewAdditions(days, limit));
    warmPostersFor(additions);
    res.json({ additions, count: additions.length });
  } catch (err) {
    console.error('Error fetching new additions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/new-additions/matching
 * Get new additions matching a saved criteria set.
 * Query params: criteriaId (required), days (default 7, at most 30)
 */
app.get('/api/new-additions/matching', (req, res) => {
  try {
    const criteriaId = parseInt(req.query.criteriaId, 10);
    const days = parseInt(req.query.days, 10) || 7;

    if (!criteriaId) {
      return res.status(400).json({ error: 'criteriaId is required' });
    }

    const matching = withExternalIds(getMatchingNewAdditions(criteriaId, days));
    warmPostersFor(matching);
    res.json({ items: matching, count: matching.length });
  } catch (err) {
    console.error('Error fetching matching additions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/criteria
 * Save a filter criteria set.
 * Body: { name, criteria: {...filters} }
 */
app.post('/api/criteria', (req, res) => {
  try {
    const { name, criteria } = req.body;

    if (!name || !criteria) {
      return res.status(400).json({ error: 'name and criteria are required' });
    }

    const saved = saveCriteria(name, criteria);
    res.status(201).json({ criteria: saved });
  } catch (err) {
    console.error('Error saving criteria:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/criteria
 * List all saved criteria.
 */
app.get('/api/criteria', (req, res) => {
  try {
    const criteria = getSavedCriteria();
    res.json({ criteria });
  } catch (err) {
    console.error('Error fetching criteria:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/criteria/:id
 * Delete a saved criteria.
 */
app.delete('/api/criteria/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = deleteCriteria(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Criteria not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting criteria:', err.message);
    res.status(500).json({ error: err.message });
  }
});
