import { PLEX_CLIENT_ID, failureText, firstReachableConnection, pickBestConnection } from './plex-connections.js';
import { MAX_SMALL_ANSWER_BYTES, plexFetch, readJsonWithin } from './plex-fetch.js';
import { forgetListedLibrariesExcept } from './plex-library.js';

const ABANDONED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const reportedAbandoned = new Set();

/** A shared server that is offline and that plex.tv last saw over 30 days ago. */
export function isAbandonedShare(device, now = Date.now()) {
  if (device.owned || device.presence) return false;
  const lastSeen = Date.parse(device.lastSeenAt || '');
  return Number.isFinite(lastSeen) && now - lastSeen > ABANDONED_AFTER_MS;
}

function noteAbandoned(device) {
  if (reportedAbandoned.has(device.clientIdentifier)) return;
  reportedAbandoned.add(device.clientIdentifier);
  console.warn(
    `Skipping shared server ${device.name}: offline, last seen by plex.tv ${device.lastSeenAt}`
  );
}

const reportedHttpOnly = new Set();

function noteHttpOnly(device) {
  if (reportedHttpOnly.has(device.clientIdentifier)) return;
  reportedHttpOnly.add(device.clientIdentifier);
  console.warn(
    `Skipping server ${device.name}: no https address is listed for it, and the Plex token is not sent over plain http. ` +
      'Turn on secure connections on that server, or set PLEX_ALLOW_HTTP=1 to use plain http anyway.'
  );
}

/**
 * Has the owner chosen to let the Plex token travel over plain http?
 *
 * Off unless asked for. Read each time it is needed, and spelled the way the
 * other switches accept ("1", "true", "yes", "on").
 */
export function plainHttpAllowed() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PLEX_ALLOW_HTTP || '').trim().toLowerCase());
}

/**
 * "https" or "http", read off the address itself. plex.tv also states a
 * `protocol` next to each address, but the address is what the token is sent
 * to, so the address is what is judged.
 */
function schemeOf(uri) {
  try {
    const { protocol } = new URL(uri);
    return protocol === 'https:' ? 'https' : protocol === 'http:' ? 'http' : null;
  } catch {
    return null;
  }
}

/**
 * Is the machine at this address really this Plex server? Asked without a
 * token: /identity needs none, and the point is to find out who is there
 * before handing anything over.
 *
 * On its own this stops a bystander, not an impostor: the identifier it
 * checks is one a Plex server gives to anyone who asks, so any machine can
 * repeat it. The proof is the https certificate (see trustedConnections).
 */
export async function identifiesAs(uri, clientIdentifier, fetchImpl = fetch) {
  try {
    // plexFetch hands its fetch a URL object; the stand-ins the tests pass in
    // are written for a plain address, so they are given one.
    const res = await plexFetch(
      `${uri}/identity`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000), maxAnswerBytes: MAX_SMALL_ANSWER_BYTES },
      (url, options) => fetchImpl(String(url), options)
    );
    if (!res.ok) return false;
    const answer = await res.json();
    return Boolean(clientIdentifier) && answer?.MediaContainer?.machineIdentifier === clientIdentifier;
  } catch {
    return false;
  }
}

/**
 * The connections it is safe to send a token to.
 *
 * A "local" address (192.168.x, 10.x, 172.17.x inside Docker) only means
 * something on the network the server sits on. For a server shared by someone
 * else that is their home, so here it points at whatever device happens to
 * hold that address, and every probe handed that device the share token: those
 * are dropped outright. Your own server may be at home, or it may be a
 * seedbox or a machine at another house, in which case its local addresses
 * are just as wrong here. So each one is kept only once the machine at that
 * address has said it is this server.
 *
 * And only https addresses are kept at all, for every server. Saying "I am
 * that server" over plain http proves nothing, because the name it says is
 * public: a laptop that took the address of a server that was switched off
 * could say it and be sent the token. Over https the server's plex.direct
 * certificate proves who is answering, on every connection. Plain http comes
 * back only when the owner asks for it with PLEX_ALLOW_HTTP=1 (a server with
 * secure connections turned off, a router that will not look up plex.direct
 * names), knowing that any machine at that address can then receive the token.
 */
export async function trustedConnections(raw, fetchImpl = fetch) {
  const allowHttp = plainHttpAllowed();
  const connections = (raw.connections || [])
    .map((c) => ({ ...c, protocol: schemeOf(c?.uri) }))
    .filter((c) => c.protocol === 'https' || (c.protocol === 'http' && allowHttp));
  if (!raw.owned) return connections.filter((c) => !c.local);
  const checked = await Promise.all(
    connections.map(async (c) => (!c.local || (await identifiesAs(c.uri, raw.clientIdentifier, fetchImpl)) ? c : null))
  );
  return checked.filter(Boolean);
}

// The servers plex.tv named in its last answer. This is not the list
// getServers returns: that list leaves out a server with no usable address
// right now (your own server, switched off, with only a home address; a
// server with only http addresses) and a shared server that has been offline
// for a month. All of those are still on the account, so plex.tv still names
// them. Only a server that plex.tv no longer names at all has stopped being
// shared.
let namedInLastAnswer = null;

/**
 * The identifiers of the servers plex.tv named in the last answer it gave to
 * getServers, in whatever state they are. Null until plex.tv has answered
 * once in this process. A failed lookup leaves it as it was, so anything
 * removed on the strength of it should be removed where getServers has just
 * returned, not later.
 */
export function serversNamedByPlexTv() {
  return namedInLastAnswer;
}

/**
 * Get all Plex servers (owned + shared) accessible with the given token.
 *
 * Each answer from plex.tv is also where the app learns that a share has
 * ended: the stored libraries of a server the answer no longer names are
 * removed here (forgetListedLibrariesExcept). When plex.tv cannot be reached,
 * or its answer cannot be read, this function throws before that point and
 * nothing is removed.
 */
export async function getServers(plexToken) {
  // includeHttps=1 asks plex.tv for each server's https (plex.direct)
  // addresses. It used to be left out, and whatever came back was used as
  // given. The token is sent as a header, so no address this app builds
  // holds it.
  const url = `https://plex.tv/api/v2/resources?includeHttps=1&X-Plex-Client-Identifier=${PLEX_CLIENT_ID}`;

  let res;
  let failure;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Plex-Token': plexToken },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // fetch quotes a header value it cannot send, and this one is the token.
    failure = failureText(err);
  }
  if (!res) throw new Error(`Could not reach plex.tv: ${failure}`);

  if (!res.ok) {
    throw new Error(`Plex API error: ${res.status} ${res.statusText}`);
  }

  // plex.tv is asked with a plain fetch, so its answer is counted here: the
  // list of an account's servers is a few kilobytes per server.
  const devices = await readJsonWithin(res, MAX_SMALL_ANSWER_BYTES);

  // Filter for devices that provide "server", leaving out shared servers that
  // plex.tv itself has not seen for a month. Their owner has shut them down or
  // moved on; probing them every five minutes only filled the log (one had
  // been gone since May). Your own servers are always kept, however long they
  // have been off, and a returning server comes back on the next refresh.
  const servers = devices.filter((d) => {
    if (!d.provides || !d.provides.includes('server')) return false;
    if (isAbandonedShare(d)) {
      noteAbandoned(d);
      return false;
    }
    return true;
  });

  // Probe every server concurrently; within each, probe all connections at once
  // and keep the best-ranked reachable one. Avoids serial 5s timeouts piling up
  // across servers and connections.
  const results = await Promise.all(
    servers.map(async (raw) => {
      const server = { ...raw, connections: await trustedConnections(raw) };
      const bestUri = pickBestConnection(server.connections);
      if (!bestUri) {
        // Say why a server went missing, once, when the https rule is the reason.
        const onlyHttp = (raw.connections || []).some((c) => schemeOf(c?.uri) === 'http' && (raw.owned || !c.local));
        if (onlyHttp && !plainHttpAllowed()) noteHttpOnly(raw);
        return null;
      }

      // Shared servers have their own accessToken
      const serverToken = server.accessToken || plexToken;

      const reachableUri = await firstReachableConnection(server.connections, serverToken);

      return {
        name: server.name,
        sourceTitle: server.sourceTitle || null,
        clientIdentifier: server.clientIdentifier,
        uri: reachableUri || bestUri,
        reachable: reachableUri !== null,
        owned: server.owned || false,
        accessToken: server.accessToken || plexToken,
        connections: (server.connections || []).map((c) => ({
          uri: c.uri,
          local: c.local,
          protocol: c.protocol,
        })),
      };
    })
  );

  // Done last, once the whole lookup has worked, and only ever from the
  // answer plex.tv has just given. Every server it names counts, reachable or
  // not: one that is switched off, slow, without a usable address or left out
  // above as abandoned keeps what is stored for it.
  namedInLastAnswer = devices
    .filter((d) => d?.provides?.includes('server'))
    .map((d) => d.clientIdentifier)
    .filter(Boolean);
  try {
    forgetListedLibrariesExcept(namedInLastAnswer);
  } catch (err) {
    console.error('Could not clear the stored libraries of servers that are no longer shared:', err.message);
  }

  return results.filter(Boolean);
}
