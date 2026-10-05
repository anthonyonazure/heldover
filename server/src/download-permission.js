// Has the owner of a Plex server allowed this account to download from it?
//
// Plex's own apps hide the download button unless the owner switched on
// "Allow Downloads" for the person they shared with. The file addresses
// themselves do not check that switch (playing a file uses the same address),
// so an app that simply fetches them goes around the owner's choice. This app
// asks first, the way Plex's apps do, and takes "no" or "no answer" as no.
//
// The switch is reported as `allowSync` on the server's front page and again
// on each title. Both must say yes.

import { MAX_SMALL_ANSWER_BYTES, plexFetch } from './plex-fetch.js';

const CHECK_AGAIN_AFTER_MS = 10 * 60 * 1000;
const known = new Map();

/** What one Plex answer says: true only for an explicit yes. */
export function allowsDownloads(container) {
  const value = container?.allowSync;
  return value === true || value === 1 || value === '1';
}

/**
 * @param {{ clientIdentifier: string, uri: string, owned?: boolean }} server
 * @param {string} token that server's own access token
 * @param {typeof fetch} [fetchImpl] replaced in tests
 */
export async function downloadsAllowedOn(server, token, fetchImpl = fetch) {
  // Your own server: your files, your call (the Settings switch).
  if (server.owned) return true;

  const cached = known.get(server.clientIdentifier);
  if (cached && Date.now() - cached.at < CHECK_AGAIN_AFTER_MS) return cached.allowed;

  let allowed = false;
  try {
    // A redirect to another machine is refused, so the token in the header
    // only ever reaches the server it belongs to. plexFetch hands its fetch a
    // URL object; the stand-ins in the tests expect a plain address.
    const res = await plexFetch(
      `${server.uri}/`,
      { headers: { Accept: 'application/json', 'X-Plex-Token': token }, signal: AbortSignal.timeout(10_000), maxAnswerBytes: MAX_SMALL_ANSWER_BYTES },
      (url, options) => fetchImpl(String(url), options)
    );
    if (res.ok) allowed = allowsDownloads((await res.json()).MediaContainer);
  } catch {
    // Unreachable is not permission. Not remembered, so the next try asks again.
    return false;
  }
  known.set(server.clientIdentifier, { allowed, at: Date.now() });
  return allowed;
}

export const NOT_ALLOWED_MESSAGE =
  'The owner of this server has not turned on downloads for your account. They can allow it in their Plex sharing settings.';

/** For tests. */
export function forgetDownloadPermissions() {
  known.clear();
}
