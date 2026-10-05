/**
 * A Plex library or item key, checked before it goes into a Plex address.
 *
 * Keys arrive from query strings and request bodies and were pasted straight
 * into paths such as /library/sections/<key>/all, with the server's token
 * added on the end. Express decodes %2F in route parameters, so a key like
 * "1/../../:/scrobble?..." walked the request to other Plex endpoints, which
 * then ran with the owner's (or a friend's) token: marking things watched,
 * starting library scans. Plex section and item keys are always whole numbers.
 */
export function plexId(value) {
  const text = String(value ?? '');
  if (!/^\d{1,12}$/.test(text)) {
    const err = new Error('Not a valid Plex library or item id');
    err.status = 400;
    throw err;
  }
  return text;
}
