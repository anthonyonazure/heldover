import { getClientId } from './config.js';
import { AnswerTooLargeError, OffOriginError, plexFetch } from './plex-fetch.js';

// Each install is its own device in Plex's eyes, so people can see and revoke it.
export const PLEX_CLIENT_ID = getClientId();

/**
 * Pick the best connection URI for a server.
 * Prefer non-local, HTTPS connections. Fall back to whatever is available.
 */
export function pickBestConnection(connections) {
  if (!connections || connections.length === 0) return null;

  // Prefer relay/remote HTTPS connections
  const remote = connections.find(
    (c) => !c.local && c.protocol === 'https'
  );
  if (remote) return remote.uri;

  // Then any HTTPS
  const https = connections.find((c) => c.protocol === 'https');
  if (https) return https.uri;

  // Then any non-local
  const nonLocal = connections.find((c) => !c.local);
  if (nonLocal) return nonLocal.uri;

  // Fall back to first available
  return connections[0].uri;
}

/**
 * What went wrong with a request, in words that are safe to show and to log.
 *
 * fetch quotes the whole address in some of its errors ("Failed to parse URL
 * from ...", "... a URL that includes credentials: ...") and the header value
 * in others ("... is an invalid header value"), and either can hold a token.
 * Those errors used to travel untouched into answers, the backoff record and
 * the log. So the words are chosen here from a fixed set, and the original
 * message is never passed on. The short code (ENOTFOUND, CERT_HAS_EXPIRED)
 * comes from Node and says why a connection failed without naming anything.
 */
export function failureText(err) {
  if (err instanceof OffOriginError || err instanceof AnswerTooLargeError) return err.message;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'No answer in time';
  if (err?.message === 'fetch failed') {
    const code = err.cause?.code;
    return typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code) ? `Could not connect (${code})` : 'Could not connect';
  }
  return 'The request could not be sent';
}

/**
 * plexFetch for callers whose errors are shown or logged: a failure arrives
 * with the safe words above in place of fetch's own.
 */
export async function plexRequest(url, options, fetchImpl) {
  let failure;
  try {
    return await plexFetch(url, options, fetchImpl);
  } catch (err) {
    if (err instanceof OffOriginError) throw err;
    failure = new Error(failureText(err));
    // Kept so "was it a timeout?" still has an answer.
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') failure.name = err.name;
  }
  // Thrown out here, not from the catch, so the original error (and the
  // address or token in its text) is not carried along as the cause.
  throw failure;
}

/**
 * The origin of a server address, for log lines: never a path, a query string
 * or the sign-in part of an address.
 */
function nameOf(uri) {
  try {
    return new URL(uri).origin;
  } catch {
    return 'an unreadable address';
  }
}

/**
 * Test if a server connection is reachable.
 */
async function testConnection(uri, plexToken) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // The token is a header, not part of the address: see fetchFromServerWithFallback.
    const res = await plexFetch(`${uri}/identity`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': plexToken },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * GET /identity on a single URI. /identity is unauthenticated, but a revoked
 * share or wrong token surfaces as 401, which we want to distinguish from a
 * dead host. Returns { ok, status } where status is the HTTP code or a
 * network-level label.
 */
async function probeIdentity(uri, token, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await plexFetch(`${uri}/identity`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { ok: res.ok, httpStatus: res.status };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, httpStatus: null, aborted: err.name === 'AbortError' };
  }
}

/**
 * Check server health. Probes every connection the caller passes (the server
 * list has already dropped local addresses that are not that server) in
 * parallel with the per-server token and reports online if ANY responds.
 * A server is only "offline" when all of its connections fail.
 *
 * @param {string} uri - Primary/best URI (used as the sole probe if no connections given)
 * @param {string} token - Per-server access token (NOT the global account token for shares)
 * @param {Array} [connections] - Optional connections array to probe for failover
 * Returns { online, latencyMs, status }. status: 'online' | 'unauthorized' | 'slow' | 'offline'.
 */
export async function checkServerHealth(uri, token, connections) {
  const start = Date.now();

  const targets =
    connections && connections.length > 0
      ? [...connections]
          .sort((a, b) => {
            const score = (c) =>
              !c.local && c.protocol === 'https' ? 0 : c.protocol === 'https' ? 1 : !c.local ? 2 : 3;
            return score(a) - score(b);
          })
          .map((c) => c.uri)
      : [uri];

  const probes = await Promise.all(targets.map((t) => probeIdentity(t, token)));
  const latencyMs = Date.now() - start;

  if (probes.some((p) => p.ok)) {
    return { online: true, latencyMs, status: 'online' };
  }
  // Any connection answering 401/403 means the host is alive but the token is
  // rejected — a revoked/expired share, not an offline server.
  if (probes.some((p) => p.httpStatus === 401 || p.httpStatus === 403)) {
    return { online: false, latencyMs, status: 'unauthorized' };
  }
  if (probes.some((p) => p.aborted)) {
    return { online: false, latencyMs, status: 'slow' };
  }
  return { online: false, latencyMs, status: 'offline' };
}

/**
 * How long one request to a Plex server may take, from the moment it is sent
 * to the last byte of its answer. A page of 500 titles from a busy shared
 * server can take a minute to put together; the answer itself is a few
 * megabytes and arrives in seconds.
 */
export const PLEX_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Fetch a path from a Plex server with connection fallback.
 * Tries the primary URI first, then falls back to other connections.
 *
 * Each attempt has one deadline that covers the whole answer, the body
 * included. It used to end when the headers arrived, so a server that sent
 * its headers and then slowed or stopped the body kept the caller waiting
 * with no limit, and a library read kept one of its two places for as long.
 *
 * @param {Array} connections - Array of { uri, local, protocol } objects
 * @param {string} path - API path (e.g., '/library/sections')
 * @param {string} token - Plex auth token
 * @param {object} [options] - fetch options (headers, etc.), and two of our own:
 * @param {number} [options.timeoutMs] - the deadline for one attempt, headers
 *   and body together (PLEX_REQUEST_TIMEOUT_MS when left out)
 * @param {AbortSignal} [options.signal] - fires when the caller no longer
 *   wants the answer: the request in flight ends at once, while the headers
 *   are awaited or while the body is read, and no other connection is tried
 * @returns {Promise<Response>} - The first successful response
 */
export async function fetchFromServerWithFallback(connections, path, token, options = {}) {
  if (!connections || connections.length === 0) {
    throw new Error('No connections available');
  }
  const { signal: stop, timeoutMs = PLEX_REQUEST_TIMEOUT_MS, ...rest } = options;

  // Order connections: best first (same logic as pickBestConnection)
  const ordered = [...connections].sort((a, b) => {
    // Remote HTTPS first
    const scoreA = (!a.local && a.protocol === 'https' ? 0 : a.protocol === 'https' ? 1 : !a.local ? 2 : 3);
    const scoreB = (!b.local && b.protocol === 'https' ? 0 : b.protocol === 'https' ? 1 : !b.local ? 2 : 3);
    return scoreA - scoreB;
  });

  let lastError = null;
  for (const conn of ordered) {
    stop?.throwIfAborted();
    // Never cleared: a signal given to fetch also ends a body that is still
    // being read, which is what keeps the deadline in force after the headers.
    // Its timer does not keep the process alive, and it is let go when it fires.
    const deadline = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      // The token travels as a header and never in the address. An address
      // ends up in error text, in the backoff record and in the log, and all
      // three reach devices that only look; a header does not. A redirect to
      // another machine is refused (plexFetch), and counts as this connection
      // failing: the next one is tried.
      res = await plexRequest(`${conn.uri}${path}`, {
        ...rest,
        headers: { ...rest.headers, 'X-Plex-Token': token },
        signal: stop ? AbortSignal.any([deadline, stop]) : deadline,
      });
    } catch (err) {
      // Nobody is waiting any more: the next connection is not tried.
      if (stop?.aborted) throw stop.reason;
      // Already safe words (see failureText), so they can be kept and shown.
      lastError = err;
      console.warn(`Connection ${nameOf(conn.uri)} failed (${err.message}), trying next...`);
      continue;
    }

    if (res.ok) return res;

    // On 5xx, try next connection. The address is left out of the text: the
    // backoff reads "401" or "403" anywhere in it as a revoked share, and a
    // plex.direct name is a long run of digits and letters.
    if (res.status >= 500) {
      lastError = new Error(`${res.status} ${res.statusText}`);
      console.warn(`Connection ${nameOf(conn.uri)} returned ${res.status}, trying next...`);
      continue;
    }

    // On 4xx or other client errors, don't retry: it's not a connection issue.
    throw new Error(`${res.status} ${res.statusText}`);
  }

  throw lastError instanceof Error ? lastError : new Error('All connections failed');
}

/**
 * Probe all of a server's connections in parallel and return the best-ranked
 * reachable URI (same preference order as pickBestConnection), or null if none
 * respond. Parallel probing means total wait is ~one timeout, not N timeouts.
 */
export async function firstReachableConnection(connections, plexToken) {
  if (!connections || connections.length === 0) return null;

  const ranked = [...connections].sort((a, b) => {
    const score = (c) => (!c.local && c.protocol === 'https' ? 0 : c.protocol === 'https' ? 1 : !c.local ? 2 : 3);
    return score(a) - score(b);
  });

  const reachable = await Promise.all(
    ranked.map(async (c) => ({ uri: c.uri, ok: await testConnection(c.uri, plexToken) }))
  );

  const hit = reachable.find((r) => r.ok);
  return hit ? hit.uri : null;
}
