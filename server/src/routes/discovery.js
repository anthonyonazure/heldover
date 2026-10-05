import { profileIdFrom } from '../profiles.js';
import { getActiveSessions, getClients, getTransientToken, playMediaOnClient } from '../plex.js';
import { becauseYouLiked, becauseYouLikedRows, hiddenGems, recentlyAddedNotYetSeen, percentMatch } from '../recommendations.js';
import { parseVoiceQuery } from '../voice-parse.js';
import { buildWrapped } from '../wrapped.js';
import { listBackedOff } from '../server-backoff.js';
import { app, clampCount, ensureServers, getPlexToken } from '../app.js';
import { loadCachedLibrary, loadOrFetchLibrary } from '../library-loader.js';
import { plexRequest } from '../plex-connections.js';
import { plexId } from '../plex-ids.js';
import { isListedItem, isRememberedLibrary } from '../plex-library.js';

// ---------- Discovery (Because You Liked, Hidden Gems, Recently Added, Percent Match) ----------

app.get('/api/discovery/because-you-liked', async (req, res) => {
  try {
    const { serverKey, libraryKey, seedKey } = req.query;
    if (!serverKey || !libraryKey || !seedKey) {
      return res.status(400).json({ error: 'serverKey, libraryKey, seedKey required' });
    }
    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) return res.status(404).json({ error: 'Library not found' });
    const seedItem = items.find((it) => String(it.ratingKey || it.plex_key || it.plexKey) === String(seedKey));
    if (!seedItem) return res.status(404).json({ error: 'Seed item not found' });
    const picks = becauseYouLiked({ items, seedItem, serverKey, count: clampCount(req.query.count, 12, 60), profileId: profileIdFrom(req) });
    res.json({ seed: { title: seedItem.title, ratingKey: seedItem.ratingKey }, items: picks, count: picks.length });
  } catch (err) {
    console.error('Error in because-you-liked:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/discovery/because-you-liked-rows', async (req, res) => {
  try {
    const { serverKey, libraryKey } = req.query;
    if (!serverKey || !libraryKey) return res.status(400).json({ error: 'serverKey and libraryKey required' });
    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) return res.status(404).json({ error: 'Library not found' });
    const rows = becauseYouLikedRows({ items, serverKey, count: clampCount(req.query.count, 3, 60), profileId: profileIdFrom(req) });
    res.json({ rows });
  } catch (err) {
    console.error('Error in because-you-liked-rows:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/discovery/hidden-gems', async (req, res) => {
  try {
    const { serverKey, libraryKey } = req.query;
    if (!serverKey || !libraryKey) return res.status(400).json({ error: 'serverKey and libraryKey required' });
    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) return res.status(404).json({ error: 'Library not found' });
    const picks = hiddenGems({ items, serverKey, count: clampCount(req.query.count, 20, 60), profileId: profileIdFrom(req) });
    res.json({ items: picks, count: picks.length });
  } catch (err) {
    console.error('Error in hidden-gems:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/discovery/recently-added', async (req, res) => {
  try {
    const { serverKey, libraryKey } = req.query;
    if (!serverKey || !libraryKey) return res.status(400).json({ error: 'serverKey and libraryKey required' });
    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) return res.status(404).json({ error: 'Library not found' });
    const picks = recentlyAddedNotYetSeen({
      items,
      serverKey,
      days: parseInt(req.query.days, 10) || 30,
      count: clampCount(req.query.count, 20, 60),
      profileId: profileIdFrom(req),
    });
    res.json({ items: picks, count: picks.length });
  } catch (err) {
    console.error('Error in recently-added:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/discovery/percent-match/:plexKey', (req, res) => {
  try {
    const { serverKey, libraryKey } = req.query;
    const { plexKey } = req.params;
    if (!serverKey || !libraryKey) return res.status(400).json({ error: 'serverKey and libraryKey required' });
    const items = loadCachedLibrary(serverKey, libraryKey);
    if (!items) return res.status(404).json({ error: 'Library not cached' });
    const item = items.find((it) => String(it.ratingKey || it.plex_key || it.plexKey) === String(plexKey));
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ percent: percentMatch(item, profileIdFrom(req)) });
  } catch (err) {
    console.error('Error computing percent-match:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Plex Sessions / Clients / Remote Play ----------

app.get('/api/plex/sessions', async (req, res) => {
  try {
    const token = getPlexToken();
    const servers = await ensureServers();
    const all = [];
    await Promise.all(
      servers
        .filter((s) => s.owned)
        .map(async (server) => {
          const sessions = await getActiveSessions(server.uri, server.accessToken || token, (section) =>
            isRememberedLibrary(server.clientIdentifier, section)
          );
          for (const s of sessions) {
            all.push({ ...s, serverName: server.name, serverKey: server.clientIdentifier });
          }
        })
    );
    res.json({ sessions: all, count: all.length });
  } catch (err) {
    console.error('Error fetching sessions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/plex/clients', async (req, res) => {
  try {
    const token = getPlexToken();
    const servers = await ensureServers();
    const all = [];
    await Promise.all(
      servers
        .filter((s) => s.owned)
        .map(async (server) => {
          const clients = await getClients(server.uri, server.accessToken || token);
          for (const c of clients) {
            all.push({ ...c, serverName: server.name, serverKey: server.clientIdentifier });
          }
        })
    );
    res.json({ clients: all, count: all.length });
  } catch (err) {
    console.error('Error fetching clients:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/plex/play', async (req, res) => {
  try {
    const { serverKey, clientMachineIdentifier, ratingKey } = req.body || {};
    if (!serverKey || !clientMachineIdentifier || !ratingKey) {
      return res.status(400).json({ error: 'serverKey, clientMachineIdentifier and ratingKey required' });
    }
    const token = getPlexToken();
    const servers = await ensureServers();
    const server = servers.find((s) => s.clientIdentifier === serverKey);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    // Only a title from a library the app lists. The play command names the
    // item by its number alone, and a number from a request could name
    // anything on the server (a photo, a music track). So Plex is asked about
    // the item once, with the token as a header, and its answer is checked
    // before the players are listed, before a short-lived token is made and
    // before any command goes to a player.
    const serverToken = server.accessToken || token;
    const metaRes = await plexRequest(`${server.uri}/library/metadata/${plexId(ratingKey)}`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': serverToken },
      signal: AbortSignal.timeout(15_000),
    });
    if (metaRes.status === 404) return res.status(404).json({ error: 'Item not found' });
    if (!metaRes.ok) return res.status(502).json({ error: `Plex API error: ${metaRes.status}` });
    if (!(await isListedItem(server, await metaRes.json(), serverToken))) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const clients = await getClients(server.uri, server.accessToken || token);
    const client = clients.find((c) => c.machineIdentifier === clientMachineIdentifier);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // The player gets a short-lived token, never the server's own: see
    // getTransientToken for why.
    const transient = await getTransientToken(server.uri, server.accessToken || token);
    const url = new URL(server.uri);
    const result = await playMediaOnClient({
      client,
      serverIdentifier: server.clientIdentifier,
      serverAddress: url.hostname,
      serverPort: url.port || (url.protocol === 'https:' ? 443 : 32400),
      serverProtocol: url.protocol.replace(':', ''),
      ratingKey,
      token: transient,
    });
    if (!result.ok) return res.status(502).json({ error: `Client returned ${result.status}` });
    res.json({ success: true });
  } catch (err) {
    console.error('Error starting playback:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Voice ----------

app.post('/api/voice/parse', (req, res) => {
  try {
    const { transcript } = req.body || {};
    if (!transcript) return res.status(400).json({ error: 'transcript is required' });
    const result = parseVoiceQuery(transcript);
    res.json(result);
  } catch (err) {
    console.error('Error parsing voice:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Wrapped ----------

app.get('/api/wrapped', async (req, res) => {
  try {
    const { serverKey, libraryKey } = req.query;
    const days = parseInt(req.query.days, 10) || 90;
    if (!serverKey || !libraryKey) return res.status(400).json({ error: 'serverKey and libraryKey required' });
    const items = await loadOrFetchLibrary(serverKey, libraryKey);
    if (!items) return res.status(404).json({ error: 'Library not found' });
    const wrapped = buildWrapped({ items, days });
    res.json(wrapped);
  } catch (err) {
    console.error('Error building wrapped:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Server Backoff visibility ----------

app.get('/api/servers/backoff', (req, res) => {
  try {
    res.json({ backedOff: listBackedOff() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
