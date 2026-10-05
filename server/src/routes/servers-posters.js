import { prewarm as prewarmPosters, readCached as readCachedPoster, isCached as isCachedPoster, getPoster } from '../poster-cache.js';
import { externalIdsFor } from '../corpus-index.js';
import { app, cachedServers, ensureServers, getPlexToken } from '../app.js';
import { plexFetch } from '../plex-fetch.js';
import { canonicalServer, isIssuedPicture, readPictureAddress } from '../plex-images.js';

// ---------- Routes ----------

/**
 * GET /api/servers
 * List all Plex servers (owned + shared).
 */
app.get('/api/servers', async (req, res) => {
  try {
    const servers = await ensureServers(req.query.refresh === 'true');
    // The access token is stripped on the way out. It is full control of
    // someone else's Plex server, the browser has never had a use for it, and
    // it was being handed to every page that asked for the server list.
    res.json({
      servers: servers.map((server) => {
        const safe = { ...server };
        delete safe.accessToken;
        return safe;
      }),
    });
  } catch (err) {
    console.error('Error fetching servers:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/image?server=<uri>&path=<plex path>&sig=<signature>
 * Fetch a poster from Plex and pass it on, so the token stays here.
 *
 * The `server` value is checked against the servers we actually know about
 * before anything is fetched. Without that check this route would happily
 * fetch any address handed to it, which turns the app into a way for a web
 * page to reach machines on this network that it could never reach directly.
 * An allow-list of things we already talk to is the first defence.
 *
 * The second is the signature. A known server and a well-formed path used to
 * be enough, so a device could count through item numbers and be sent the
 * picture of each one, items in sections the app never lists included. Only
 * an address the app itself issued (proxiedImageUrl in plex-images.js) is
 * served now.
 */
// Compared as origins rather than as strings, because the same server is
// written both as "https://host:443" and "https://host" depending on where the
// address came from, and a plain string compare would reject half of its own
// posters.
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// One spelling per server: canonicalServer (plex-images.js) reduces the
// `server` value to its origin before the signature check, the cache lookup,
// the server check and the fetch.

function isKnownServer(servers, serverUri) {
  return servers.some(
    (s) => sameOrigin(s.uri, serverUri) || (s.connections || []).some((c) => sameOrigin(c.uri, serverUri))
  );
}

// Posters are shown in cards about 150 pixels wide. Asking for them at 400
// leaves room for a sharp screen and still throws away most of the weight:
// the originals run to a median of 113KB and occasionally 2MB, which is an
// absurd amount of picture to send for a thumbnail. Plex will resize them on
// request, so the app asks for what it is actually going to draw.
const POSTER_WIDTH = 400;

// Every poster address Plex gives us has this shape. The path used to be
// glued onto the server address unchecked, so "@evil.com/x" turned
// "https://friend:32400" into a request to evil.com carrying the friend's
// token, and "/myplex/account" fetched private Plex data with it. Only this
// shape is accepted now, and the final address is checked to still point at
// the server it started from.
const PLEX_IMAGE_PATH = /^\/library\/(metadata|collections)\/\d+\/[a-z]+(\/\d+)?$/;

function isPlexImagePath(p) {
  return typeof p === 'string' && p.length < 256 && PLEX_IMAGE_PATH.test(p);
}

// Posters are tens of kilobytes. Anything past this is not a poster.
const MAX_POSTER_BYTES = 8 * 1024 * 1024;

// The limit in use. Only a test changes it, so that it can show the limit
// holding with a few kilobytes instead of sending megabytes.
let posterLimit = MAX_POSTER_BYTES;

/** For tests: a limit small enough to reach. */
export function setPosterLimitForTests(bytes) {
  posterLimit = bytes;
}

/**
 * The body of an answer, or null once it runs past `limit` bytes.
 *
 * The bytes are counted as they are read, after any unpacking, so the limit
 * does not rest on what the server says about its own answer. The length it
 * declares used to be the only thing looked at before the whole body was
 * read into memory, and two ordinary kinds of answer slip past that: one
 * sent in pieces declares no length at all, and a compressed one declares its
 * small packed size (16 KB on the wire was read as 16 MB). The server here
 * may be someone else's, so what it declares is a claim, not a bound.
 */
async function readUpTo(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Hang up, so nothing more is taken from the server. At most one piece
      // past the limit has been read by now, and it is dropped here.
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetch one poster from its Plex server, resized, with the token kept here.
 * Returns null if the poster cannot be had, which callers treat as "no image"
 * rather than as an error worth surfacing.
 */
async function fetchPosterUpstream(serverUri, imagePath) {
  if (!isPlexImagePath(imagePath)) return null;
  const servers = await ensureServers();
  const match = servers.find(
    (s) => sameOrigin(s.uri, serverUri) || (s.connections || []).some((c) => sameOrigin(c.uri, serverUri))
  );
  if (!match) return null;

  const token = match.accessToken || getPlexToken();
  const origin = new URL(serverUri).origin;

  // Both requests carry the token as a header, not in the address.
  const original = new URL(imagePath, origin);

  const resized = new URL('/photo/:/transcode', origin);
  resized.searchParams.set('width', String(POSTER_WIDTH));
  resized.searchParams.set('height', String(Math.round(POSTER_WIDTH * 1.5)));
  resized.searchParams.set('minSize', '1');
  resized.searchParams.set('upscale', '0');
  // The one place the token is still written into an address: the resizer
  // reads this inner address itself, from inside the Plex server, and has only
  // what is written here to sign in with.
  resized.searchParams.set('url', `${imagePath}?X-Plex-Token=${token}`);

  // Not every server has a working photo transcoder, and a poster at the wrong
  // size beats no poster, so a refusal falls back to the original.
  for (const url of [resized, original]) {
    if (url.origin !== origin) continue;
    try {
      // The check above covers the address that is asked. A Plex server never
      // needs to send a poster request elsewhere, so a redirect to another
      // machine is refused (plexFetch) and the check holds for the answer too.
      const upstream = await plexFetch(url, {
        headers: { 'X-Plex-Token': token },
        signal: AbortSignal.timeout(15000),
      });
      if (!upstream.ok) continue;
      // Anything that is not a picture, or is far too big to be a poster, is
      // refused before it is read, so a video file can never be pulled into
      // memory through here.
      const type = upstream.headers.get('content-type') || '';
      const length = Number(upstream.headers.get('content-length') || 0);
      if (!type.startsWith('image/') || length > posterLimit) {
        upstream.body?.cancel().catch(() => {});
        continue;
      }
      // The declared length above is only the early way out. The limit itself
      // is kept while reading: an answer that runs past it is dropped, which
      // is "no picture" like any other poster that cannot be had.
      const buffer = await readUpTo(upstream, posterLimit);
      if (buffer) return buffer;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

/**
 * Add the tmdb/imdb ids to rows that were built without them.
 *
 * The snapshot table these come from records what a library contained, not what
 * a title is elsewhere, so a "new this week" row knows nothing about TMDB. The
 * corpus already holds that mapping under the same server and rating key, so it
 * is a lookup rather than a network call.
 */
export function withExternalIds(rows) {
  const list = rows || [];
  const ids = externalIdsFor(
    list.map((r) => ({ serverKey: r.server_key || r.serverKey, ratingKey: r.item_key || r.ratingKey }))
  );
  return list.map((r) => {
    const found = ids.get(`${r.server_key || r.serverKey}:${r.item_key || r.ratingKey}`);
    // These rows come out of the snapshot table under its own column names, so
    // a title from this row looked different from the identical title anywhere
    // else in the app: everything downstream reads ratingKey and serverKey, and
    // got nothing. Named the same way here, once, rather than every caller
    // having to know which table its item came from.
    const normalised = {
      ...r,
      ratingKey: r.ratingKey || r.item_key,
      serverKey: r.serverKey || r.server_key,
      libraryKey: r.libraryKey || r.library_key,
    };
    if (!found) return normalised;
    return {
      ...normalised,
      tmdbId: normalised.tmdbId || found.tmdbId,
      imdbId: normalised.imdbId || found.imdbId,
      // The snapshot's own `type` is the one it was stored with; fall back to
      // the corpus so a trailer asks TMDB about a show as a show.
      type: normalised.type || found.type,
    };
  });
}

/**
 * Pull the posters for a set of items into the on-disk cache, in the
 * background. Takes the items a surface is about to show and works out the
 * addresses itself, so callers just hand over what they are rendering.
 */
export function warmPostersFor(items) {
  const variant = `w${POSTER_WIDTH}`;
  const entries = [];
  for (const item of items || []) {
    // The same spelling the route uses (the server reduced to its origin), so
    // a poster fetched ahead of time and the same poster asked for by a page
    // are one entry.
    const address = readPictureAddress(item?.thumb);
    if (!address) continue;
    // The same rule as the route: only an address the app issued. Callers
    // pass items the app built, so this refuses nothing today; it is here so
    // that no later caller can have a picture fetched that the route would
    // refuse to serve.
    if (!isIssuedPicture(address.server, address.path, address.sig)) continue;
    // Stored before the update under the older spelling: nothing to fetch.
    if (hasOlderCopy(address.server, address.path, variant)) continue;
    entries.push({ serverUri: address.server, imagePath: address.path });
  }
  if (entries.length === 0) return;

  prewarmPosters(
    entries,
    ({ serverUri, imagePath }) => fetchPosterUpstream(serverUri, imagePath),
    4,
    variant
  );
}

// Posters stored before the server value was reduced to its origin sit on
// disk under the address as Plex wrote it, which for a server on the default
// port has that port written out ("https://host:443"; the origin is
// "https://host"). Without a second look, every one of those would count as
// missing and be fetched again from someone else's server: a few hundred
// megabytes on a long-running install.
//
// So there is exactly one older spelling per origin, and only for an origin
// on its default port. A server on any other port was already stored under
// its origin. This is not the open-ended set of spellings the origin rule
// closed: the value looked up is worked out here from the origin, never taken
// from the request.
function olderSpelling(serverOrigin) {
  if (serverOrigin.startsWith('https://')) return /:\d+$/.test(serverOrigin) ? null : `${serverOrigin}:443`;
  if (serverOrigin.startsWith('http://')) return /:\d+$/.test(serverOrigin) ? null : `${serverOrigin}:80`;
  return null;
}

function hasOlderCopy(serverOrigin, imagePath, variant) {
  const older = olderSpelling(serverOrigin);
  return older !== null && isCachedPoster(older, imagePath, variant);
}

/**
 * A poster already on disk, under the origin or under the one older spelling.
 * The older copy is read where it lies and not stored again under the origin:
 * a second copy would count twice against the size cap, and moving it buys
 * nothing but a slightly shorter lookup.
 */
function readStoredPoster(serverOrigin, imagePath, variant) {
  const stored = readCachedPoster(serverOrigin, imagePath, variant);
  if (stored) return stored;
  const older = olderSpelling(serverOrigin);
  return older === null ? null : readCachedPoster(older, imagePath, variant);
}

function sendPoster(res, buffer, fromCache) {
  res.set('Content-Type', 'image/jpeg');
  // Posters do not change, and the address already names the exact one, so
  // the browser should ask for each of them once and never again.
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  // Says whether this came off local disk or had to be fetched from a Plex
  // server, which is the difference between one millisecond and two hundred.
  res.set('X-Poster-Cache', fromCache ? 'hit' : 'miss');
  res.end(buffer);
}

app.get('/api/image', async (req, res) => {
  try {
    const serverUri = canonicalServer(req.query.server);
    const thumbPath = req.query.path;
    if (!serverUri || !isPlexImagePath(thumbPath)) return res.status(400).end();

    // Only an address this app issued. Checked before the stored posters are
    // looked at and before plex.tv or a Plex server is asked for anything, so
    // an address that was made up costs nothing and learns nothing. The check
    // is a calculation: no network and no database read.
    if (!isIssuedPicture(serverUri, thumbPath, req.query.sig)) return res.status(403).end();

    const variant = `w${POSTER_WIDTH}`;

    // The server is checked against the list before anything is served, a
    // stored poster included. The stored copy used to be handed out first, so
    // posters of a server that had been removed from the account were still
    // shown.
    //
    // For a poster already on disk the list as last known is enough, and it
    // is not waited for: finding the servers again can take seconds (a dead
    // address is given five to answer), and a screen of stored covers should
    // not stall for that once a minute. Everything else the app does keeps
    // the list current, the 5-minute health check included.
    const knownAlready = Boolean(cachedServers && isKnownServer(cachedServers, serverUri));
    if (knownAlready) {
      const cached = readStoredPoster(serverUri, thumbPath, variant);
      if (cached) return sendPoster(res, cached, true);
    }

    let servers = null;
    try {
      servers = await ensureServers();
    } catch {
      // No server list can be had at all: see below.
    }

    if (!servers) {
      // plex.tv cannot be reached, or the Plex sign-in has expired, and no
      // list is known from earlier (the app has just started). A poster
      // already on disk needs nothing from plex.tv, and this state used to
      // blank every one of them. So what is stored is still shown, and
      // nothing is fetched.
      const cached = readStoredPoster(serverUri, thumbPath, variant);
      if (!cached) return res.status(502).end();
      return sendPoster(res, cached, true);
    }

    if (!isKnownServer(servers, serverUri)) return res.status(403).end();

    // The server was not on the list as last known (or no list was known), so
    // the stored posters have not been looked at yet. getPoster below looks
    // under the origin only.
    if (!knownAlready) {
      const cached = readStoredPoster(serverUri, thumbPath, variant);
      if (cached) return sendPoster(res, cached, true);
    }

    const { buffer, fromCache } = await getPoster(
      serverUri,
      thumbPath,
      () => fetchPosterUpstream(serverUri, thumbPath),
      variant
    );

    if (!buffer) return res.status(404).end();
    sendPoster(res, buffer, fromCache);
  } catch {
    // A missing poster is not worth a stack trace in the log every time a
    // library has a few unartworked entries.
    res.status(502).end();
  }
});
