import crypto from 'crypto';
import { getPictureKey } from './config.js';

const IMAGE_ROUTE = '/api/image?';

// One spelling per server. The picture route checks a server by its origin,
// but the poster cache used to be keyed on the `server` value exactly as it
// was sent. So "https://friend:32400/a", "https://friend:32400?b" and any
// number more all passed the check, all missed the cache, and each fetched and
// stored the same poster again. Reduced to its origin first, one server and
// one path is one stored poster, one fetch and one signed address, however
// the address was written.
export function canonicalServer(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

// Every picture address the app hands out is signed with this install's own
// key (config.js). The picture route used to fetch the picture of any item
// number on a known server with that server's token, so a device could count
// through the numbers and receive pictures of items the app never lists (a
// friend's personal photos, say). Now the route serves only an address that
// carries the signature made here, and only the app can make one.
//
// HMAC-SHA256 over the server's origin and the path, cut to 16 bytes (128
// bits). Guessing can only be done by asking this app, one request per guess,
// and 128 bits is far beyond that; the full 32 bytes would only make every
// one of several hundred thousand stored addresses longer. The first line of
// the signed text says what the signature is for, so the key signing anything
// else later can never produce a value that passes here.
const pictureKey = Buffer.from(getPictureKey(), 'hex');
const SIGNATURE_BYTES = 16;

function pictureSignature(serverOrigin, imagePath) {
  return crypto
    .createHmac('sha256', pictureKey)
    .update(`heldover-picture-v1\n${serverOrigin}\n${imagePath}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString('base64url');
}

/**
 * Did this app issue a picture address for this server and path?
 * `serverOrigin` is the server already reduced by canonicalServer. Needs no
 * network and no database read. Compared in constant time.
 */
export function isIssuedPicture(serverOrigin, imagePath, signature) {
  if (typeof serverOrigin !== 'string' || typeof imagePath !== 'string' || typeof signature !== 'string') return false;
  const given = Buffer.from(signature);
  const expected = Buffer.from(pictureSignature(serverOrigin, imagePath));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Says which picture key signed something, without saying the key. Kept in the
 * database by picture-addresses.js, to tell whether the addresses stored there
 * were signed with the key this install has now.
 */
export function pictureKeyFingerprint() {
  return crypto.createHmac('sha256', pictureKey).update('heldover-picture-key-fingerprint-v1').digest('hex').slice(0, 32);
}

/**
 * The parts of one of our own picture addresses: { server, path, sig }, with
 * the server reduced to its origin. Null for anything else.
 */
export function readPictureAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(IMAGE_ROUTE)) return null;
  const params = new URLSearchParams(address.slice(IMAGE_ROUTE.length));
  const server = canonicalServer(params.get('server'));
  const path = params.get('path');
  if (!server || !path) return null;
  return { server, path, sig: params.get('sig') };
}

/**
 * A poster address the browser can load that does NOT carry the Plex token.
 *
 * The obvious thing is to hand the browser the real Plex URL, which needs
 * `?X-Plex-Token=...` on it to work. That publishes the token to anyone who
 * opens developer tools or reads a page source, and a Plex token is not a
 * read-only key for one poster: it is full control of that server. These are
 * other people's servers, so the token is not even ours to leak.
 *
 * Instead the browser gets a pointer at our own server, which knows the token
 * and never says it out loud. The lookup is by server address rather than by
 * an id threaded through every caller, because the address is already in hand
 * at each place a poster is built.
 *
 * The address is signed (see above), so call this only with a server and a
 * path the app itself read from Plex or from its own stored rows. Never call
 * it with a value a browser sent: that would hand a signature to whoever
 * asked. A browser-sent picture address goes through acceptedPicture instead.
 */
export function proxiedImageUrl(serverUri, thumbPath) {
  if (!thumbPath) return null;
  const server = canonicalServer(serverUri);
  // A server address that cannot be read has no picture route to point at.
  if (!server) return null;
  const path = String(thumbPath);
  const params = new URLSearchParams({ server, path, sig: pictureSignature(server, path) });
  return `${IMAGE_ROUTE}${params.toString()}`;
}

// The other picture addresses the app shows are TMDB posters, which the
// browser loads from TMDB itself.
const TMDB_PICTURES = 'https://image.tmdb.org/';

/**
 * A picture address that arrived from a browser (a title being added to the
 * queue, the watchlist or episode alerts), reduced to one the app may keep and
 * show to other devices: one of our own addresses with a valid signature, or
 * a TMDB poster. Anything else becomes null, so the title is kept without a
 * picture. Nothing is ever signed here. Signing what a browser sent would let
 * a device have any item number signed and then fetch its picture.
 */
export function acceptedPicture(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  if (value.startsWith(TMDB_PICTURES)) return value;
  const own = readPictureAddress(value);
  if (!own || !isIssuedPicture(own.server, own.path, own.sig)) return null;
  // Exactly what the app issued for that server and path, without anything
  // else the browser may have added to the address.
  return proxiedImageUrl(own.server, own.path);
}

/**
 * Convert a poster address that was stored back when it carried the token.
 *
 * Fixing where addresses are built is not enough on its own: two databases
 * hold copies of the old ones and keep handing them out for days. Rather than
 * throw away every cached library and re-download it all from other people's
 * servers, the token is dropped on the way out. Anything already pointing at
 * our own server passes straight through.
 *
 * What comes out is one of our own addresses, signed. That is sound only
 * because every caller passes a row the server itself wrote from what Plex
 * said (the library cache, the search index, the new-additions table). Do not
 * use it on a value a browser sent.
 */
export function detokenizeThumb(thumb) {
  if (typeof thumb !== 'string' || !thumb.includes('X-Plex-Token=')) return thumb;
  try {
    const url = new URL(thumb);
    return proxiedImageUrl(url.origin, url.pathname);
  } catch {
    // An address we cannot read is one we certainly should not hand over.
    return null;
  }
}

/**
 * Pull the external ids out of Plex's guid list.
 *
 * Plex records them as "tmdb://584" and "imdb://tt0322259" inside a `guids`
 * array, which the app passed through untouched — so every title carried the
 * id needed to look up a trailer, and nothing ever read it. The trailer button
 * only appeared on the handful of surfaces built from a different source, and
 * was simply absent across the whole library grid.
 */
export function externalIds(guids) {
  const ids = { tmdbId: null, imdbId: null, tvdbId: null };
  for (const raw of guids || []) {
    const [scheme, value] = String(raw).split('://');
    if (!value) continue;
    if (scheme === 'tmdb') ids.tmdbId = value;
    else if (scheme === 'imdb') ids.imdbId = value;
    else if (scheme === 'tvdb') ids.tvdbId = value;
  }
  return ids;
}
