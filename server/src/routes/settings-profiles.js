import { downloadsEnabled } from '../config.js';
import { listProfiles, createProfile, updateProfile, deleteProfile } from '../profiles.js';
import { getLibraries } from '../plex.js';
import { getOmdbUsageStats } from '../ratings.js';
import { warmerStatus } from '../library-warmer.js';
import { indexLibrary, indexSize, indexedLibraryCount, matchExternal } from '../corpus-index.js';
import { PORT, app, ensureServers } from '../app.js';
import { loadCachedLibrary } from '../library-loader.js';

/**
 * GET /api/settings
 * Return current configuration state (no secrets).
 */
app.get('/api/settings', (req, res) => {
  const omdbUsage = getOmdbUsageStats();
  res.json({
    settings: {
      plexTokenConfigured: !!process.env.PLEX_TOKEN,
      tmdbApiKeyConfigured: !!process.env.TMDB_API_KEY,
      omdbApiKeyConfigured: !!process.env.OMDB_API_KEY,
      downloadsEnabled: downloadsEnabled(),
      port: PORT,
      omdbUsage,
    },
  });
});

/**
 * POST /api/settings
 * Acknowledge settings (env-based, so just returns current state).
 */
app.post('/api/settings', (req, res) => {
  res.json({
    message: 'Settings are configured via environment variables (.env file).',
    settings: {
      plexTokenConfigured: !!process.env.PLEX_TOKEN,
      tmdbApiKeyConfigured: !!process.env.TMDB_API_KEY,
      omdbApiKeyConfigured: !!process.env.OMDB_API_KEY,
      port: PORT,
    },
  });
});

// ---------- Download Routes ----------

/**
 * Format bytes into human-readable size.
 */
export function formatSize(bytes) {
  if (!bytes || bytes === 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

/**
 * Extract filename from a file path.
 */
export function extractFilename(filePath) {
  if (!filePath) return 'unknown';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1];
}

/**
 * GET /api/cache/warm: status of the background library warm-up.
 * (POST /api/cache/warm, which starts one, lives in routes/library.js. A second
 * copy here was registered after it and never ran.)
 */
app.get('/api/cache/warm', (req, res) => {
  res.json(warmerStatus());
});

/**
 * POST /api/library-match
 * Body: { items: [{ tmdbId, imdbId, title, year, type }] }
 *
 * Answers "do I already have this?" for titles found somewhere else — the
 * streaming browser especially. Owning a copy beats sending someone off to
 * Netflix, because a local copy can be cast to the TV in one tap.
 *
 * Only cached libraries are searched. A library nobody has opened yet has
 * nothing to match against, which is why the response reports how many it
 * looked through.
 */
// One-time catch-up: index whatever the caches already hold, so the searchable
// copy is not empty until the next full warm-up comes round.
export async function indexExistingCaches() {
  const token = process.env.PLEX_TOKEN;
  if (!token) return;

  let total = 0;
  try {
    const servers = await ensureServers();
    for (const server of servers) {
      try {
        const libs = await getLibraries(server.uri, server.accessToken || token, server.connections);
        for (const lib of libs) {
          const items = loadCachedLibrary(server.clientIdentifier, lib.key);
          if (items && items.length) {
            total += indexLibrary(server.clientIdentifier, lib.key, items);
          }
        }
      } catch {
        // Nothing cached for that server yet.
      }
    }
  } catch (err) {
    console.error('[corpus] catch-up failed:', err.message);
  }

  if (total) console.log(`[corpus] indexed ${total} titles from existing caches`);
}

app.post('/api/library-match', (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ matches: {}, indexedTitles: indexSize(), librariesSearched: indexedLibraryCount() });
    }
    // A catalog page is a few dozen titles. Each one is up to three lookups
    // on the request thread, so an unbounded list could stall every request.
    if (items.length > 500) return res.status(400).json({ error: 'At most 500 titles per request' });

    const found = matchExternal(items);
    res.json({
      matches: Object.fromEntries(found),
      indexedTitles: indexSize(),
      librariesSearched: indexedLibraryCount(),
    });
  } catch (err) {
    console.error('Error matching against libraries:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Viewer profiles. Everything personal — thumbs, not-interested, the queue —
 * is stored per profile, so two people with different taste do not average
 * into recommendations that suit neither of them.
 */
app.get('/api/profiles', (req, res) => {
  res.json({ profiles: listProfiles() });
});

app.post('/api/profiles', (req, res) => {
  try {
    const { name, emoji, color } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    res.json({ profile: createProfile(String(name).trim(), emoji, color) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/profiles/:id', (req, res) => {
  try {
    const profile = updateProfile(parseInt(req.params.id, 10), req.body || {});
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile });
  } catch (err) {
    // Names are unique, and a clash used to come back as a bare error page.
    if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: 'Another profile already has that name' });
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/profiles/:id', (req, res) => {
  try {
    const removed = deleteProfile(parseInt(req.params.id, 10));
    if (!removed) return res.status(404).json({ error: 'Profile not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

