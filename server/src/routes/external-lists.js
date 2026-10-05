import { getLibraries } from '../plex.js';
import { getAvailableSources, getFeaturedLists, getProviderListings, getProviderListItems } from '../external-lists.js';
import { matchListItems, matchListItemsAcross } from '../list-matcher.js';
import { app, ensureServers, getPlexToken } from '../app.js';
import { loadCachedLibrary, loadOrFetchLibrary } from '../library-loader.js';

// ---------- External Lists (MDBList / TMDB / Letterboxd / Trakt) ----------

app.get('/api/lists/sources', (req, res) => {
  try {
    res.json({ sources: getAvailableSources() });
  } catch (err) {
    console.error('Error listing sources:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lists/featured', async (req, res) => {
  try {
    const featured = await getFeaturedLists();
    res.json({ featured });
  } catch (err) {
    console.error('Error fetching featured lists:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lists/:provider', async (req, res) => {
  try {
    const listings = await getProviderListings(req.params.provider);
    res.json(listings);
  } catch (err) {
    console.error(`Error fetching ${req.params.provider} listings:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lists/:provider/items', async (req, res) => {
  try {
    const { provider } = req.params;
    const { listId, serverKey, libraryKey, matchAll } = req.query;
    if (!listId) return res.status(400).json({ error: 'listId is required' });

    const items = await getProviderListItems(provider, listId);

    // If serverKey+libraryKey provided, match against that library.
    if (serverKey && libraryKey) {
      const libItems = await loadOrFetchLibrary(serverKey, libraryKey);
      const matched = matchListItems({ listItems: items, libraryItems: libItems || [], serverKey });
      return res.json({ provider, listId, items: matched, count: matched.length });
    }

    // matchAll=true => walk every cached library and merge
    if (matchAll === 'true') {
      const servers = await ensureServers();
      const librariesByServer = [];
      for (const s of servers) {
        try {
          const libs = await getLibraries(s.uri, s.accessToken || getPlexToken(), s.connections);
          for (const lib of libs) {
            const libItems = loadCachedLibrary(s.clientIdentifier, lib.key);
            if (libItems) librariesByServer.push({ serverKey: s.clientIdentifier, items: libItems });
          }
        } catch {/* skip */}
      }
      const matched = matchListItemsAcross({ listItems: items, librariesByServer });
      return res.json({ provider, listId, items: matched, count: matched.length });
    }

    res.json({ provider, listId, items, count: items.length });
  } catch (err) {
    console.error(`Error fetching items for ${req.params.provider}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});
