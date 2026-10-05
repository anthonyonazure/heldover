import { subscribe, unsubscribe, getSubscriptions, isSubscribed, checkForNewEpisodes, getAllUnseenAlerts, getUnseenAlertCount, getAlerts, markAlertSeen, markAllAlertsSeen } from '../subscriptions.js';
import { app, ensureServers, getPlexToken } from '../app.js';

// ---------- Subscription Routes ----------

/**
 * POST /api/subscriptions
 * Subscribe to a show.
 */
app.post('/api/subscriptions', async (req, res) => {
  try {
    const item = req.body;
    if (!item || !item.title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const token = getPlexToken();
    const servers = await ensureServers();
    const sub = await subscribe(item, servers, token);
    // Plex placed it outside the libraries the app lists: nothing was stored.
    if (!sub) return res.status(404).json({ error: 'Item not found' });
    res.status(201).json({ subscription: sub });
  } catch (err) {
    console.error('Error subscribing:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/subscriptions/:id
 * Unsubscribe from a show.
 */
app.delete('/api/subscriptions/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const removed = unsubscribe(id);
    if (!removed) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error unsubscribing:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/subscriptions
 * List all subscriptions with alert counts.
 */
app.get('/api/subscriptions', (req, res) => {
  try {
    const subs = getSubscriptions();
    res.json({ subscriptions: subs, count: subs.length });
  } catch (err) {
    console.error('Error fetching subscriptions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/subscriptions/check/:plexKey
 * Check if a show is subscribed.
 */
app.get('/api/subscriptions/check/:plexKey', (req, res) => {
  try {
    const { plexKey } = req.params;
    const subscribed = isSubscribed(plexKey);
    res.json({ subscribed });
  } catch (err) {
    console.error('Error checking subscription:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/subscriptions/check-episodes
 * Manually trigger episode check for all subscriptions.
 */
app.post('/api/subscriptions/check-episodes', async (req, res) => {
  try {
    const token = getPlexToken();
    const servers = await ensureServers();
    const results = await checkForNewEpisodes(servers, token);
    res.json({ checked: true, newEpisodes: results });
  } catch (err) {
    console.error('Error checking episodes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/subscriptions/alerts
 * Get the unseen alerts across all subscriptions: the newest 200 at most.
 * `count` is how many are in this answer, `total` how many are unseen in all.
 */
app.get('/api/subscriptions/alerts', (req, res) => {
  try {
    const alerts = getAllUnseenAlerts();
    res.json({ alerts, count: alerts.length, total: getUnseenAlertCount() });
  } catch (err) {
    console.error('Error fetching alerts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/subscriptions/alerts/count
 * Get unseen alert count (for badge).
 */
app.get('/api/subscriptions/alerts/count', (req, res) => {
  try {
    const count = getUnseenAlertCount();
    res.json({ count });
  } catch (err) {
    console.error('Error fetching alert count:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/subscriptions/:id/alerts
 * Get alerts for a specific subscription.
 */
app.get('/api/subscriptions/:id/alerts', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const alerts = getAlerts(id);
    res.json({ alerts, count: alerts.length });
  } catch (err) {
    console.error('Error fetching subscription alerts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/subscriptions/alerts/:id/seen
 * Mark a single alert as seen.
 */
app.post('/api/subscriptions/alerts/:id/seen', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const marked = markAlertSeen(id);
    if (!marked) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error marking alert seen:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/subscriptions/:id/alerts/seen-all
 * Mark all alerts for a subscription as seen.
 */
app.post('/api/subscriptions/:id/alerts/seen-all', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const count = markAllAlertsSeen(id);
    res.json({ success: true, markedCount: count });
  } catch (err) {
    console.error('Error marking all alerts seen:', err.message);
    res.status(500).json({ error: err.message });
  }
});
