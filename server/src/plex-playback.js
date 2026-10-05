import { proxiedImageUrl } from './plex-images.js';
import { PLEX_CLIENT_ID, failureText, plexRequest } from './plex-connections.js';
import { MAX_SMALL_ANSWER_BYTES, plexFetch } from './plex-fetch.js';
import { plexId } from './plex-ids.js';

/**
 * List currently-playing sessions on a server. Returns one entry per active
 * stream (movie / episode being watched right now), including who's watching
 * on which client.
 *
 * `isListedSection` (optional) says whether a library section is one the app
 * lists. A session playing from any other section (photos, music) keeps its
 * title but gets no picture address: a picture address is something the app
 * vouches for, and it only vouches for titles in the libraries it shows.
 */
export async function getActiveSessions(serverUri, token, isListedSection = null) {
  try {
    // The token is a header here and below, never part of the address: an
    // address ends up in error text and in the log.
    const url = `${serverUri}/status/sessions`;
    // Not a timer cleared when the headers arrive: the limit covers the body too.
    const res = await plexRequest(url, {
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
      signal: AbortSignal.timeout(8000),
      maxAnswerBytes: MAX_SMALL_ANSWER_BYTES,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const sessions = data.MediaContainer?.Metadata || [];
    return sessions.map((s) => ({
      sessionKey: s.sessionKey,
      title: s.title,
      grandparentTitle: s.grandparentTitle || null,
      type: s.type,
      year: s.year || null,
      ratingKey: s.ratingKey,
      thumb: isListedSection && !isListedSection(s.librarySectionID) ? null : proxiedImageUrl(serverUri, s.thumb),
      duration: s.duration,
      viewOffset: s.viewOffset || 0,
      user: s.User ? { id: s.User.id, title: s.User.title, thumb: s.User.thumb } : null,
      player: s.Player ? {
        machineIdentifier: s.Player.machineIdentifier,
        title: s.Player.title,
        product: s.Player.product,
        platform: s.Player.platform,
        device: s.Player.device,
        state: s.Player.state,
        local: s.Player.local,
        address: s.Player.address,
      } : null,
    }));
  } catch (err) {
    console.warn(`getActiveSessions(${serverUri}) failed:`, err.message);
    return [];
  }
}

/**
 * List Plex clients currently visible to a server. These are devices the
 * server has seen and can target for remote playback.
 */
export async function getClients(serverUri, token) {
  try {
    const url = `${serverUri}/clients`;
    const res = await plexRequest(url, {
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
      signal: AbortSignal.timeout(8000),
      maxAnswerBytes: MAX_SMALL_ANSWER_BYTES,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const clients = data.MediaContainer?.Server || [];
    return clients.map((c) => ({
      name: c.name,
      machineIdentifier: c.machineIdentifier,
      product: c.product,
      productVersion: c.productVersion,
      platform: c.platform,
      device: c.device,
      protocol: c.protocol || 'http',
      address: c.address,
      port: c.port,
      protocolCapabilities: (c.protocolCapabilities || '').split(','),
    }));
  } catch (err) {
    console.warn(`getClients(${serverUri}) failed:`, err.message);
    return [];
  }
}

/**
 * A short-lived token for handing to a player.
 *
 * The play command goes straight to the player at the address the Plex server
 * lists for it, and that list is filled by announcements any device on the
 * network can send. It used to carry the server's long-lived token, so a
 * laptop pretending to be a player could collect the owner's token. A
 * transient token expires within 48 hours (sooner if the server restarts),
 * which is what Plex's own apps hand to players.
 */
export async function getTransientToken(serverUri, token) {
  // A redirect is refused: the header would otherwise follow it to whatever
  // machine the server named.
  const res = await plexRequest(`${serverUri}/security/token?type=delegation&scope=all`, {
    headers: { Accept: 'application/json', 'X-Plex-Token': token },
    signal: AbortSignal.timeout(10_000),
    maxAnswerBytes: MAX_SMALL_ANSWER_BYTES,
  });
  if (!res.ok) throw new Error(`Plex would not issue a short-lived token (${res.status})`);
  const data = await res.json();
  const transient = data?.MediaContainer?.token;
  if (!transient) throw new Error('Plex returned no short-lived token');
  return transient;
}

/**
 * Players are only ever sent commands on the home network: a private IPv4
 * address, never loopback, link-local or anything public.
 */
export function isHomeNetworkAddress(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address || ''));
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((n) => Number(n) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Start playback of a media item on a target Plex client.
 *
 * Plex's remote-control flow: hit the client directly at its
 * protocol://address:port and tell it to load /library/metadata/{ratingKey}
 * from the named server (machineIdentifier + address + port). The client must
 * support remote control (most Plex apps do; Plex Web does when running).
 */
export async function playMediaOnClient({
  client,
  serverIdentifier,
  serverAddress,
  serverPort,
  serverProtocol = 'http',
  ratingKey,
  token,
  offset = 0,
}) {
  if (!client || !client.address) throw new Error('client.address required');
  if (!isHomeNetworkAddress(client.address)) throw new Error('That player is not on the home network');
  const port = Number(client.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('That player has no usable port');
  const protocol = client.protocol === 'https' ? 'https' : 'http';
  if (!ratingKey) throw new Error('ratingKey required');
  if (!serverIdentifier) throw new Error('serverIdentifier required');

  const params = new URLSearchParams({
    'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
    'X-Plex-Target-Client-Identifier': client.machineIdentifier,
    machineIdentifier: serverIdentifier,
    address: serverAddress,
    port: String(serverPort),
    protocol: serverProtocol,
    key: `/library/metadata/${plexId(ratingKey)}`,
    offset: String(offset),
    'X-Plex-Token': token,
    commandID: '1',
  });

  // The short-lived token stays in this address on purpose: it is part of the
  // command (the player uses it to fetch from the server), not a sign-in to
  // the player. So the address must never reach an error or the log.
  const url = `${protocol}://${client.address}:${port}/player/playback/playMedia?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let failure;
  try {
    const res = await plexFetch(url, {
      method: 'GET',
      headers: { 'X-Plex-Client-Identifier': PLEX_CLIENT_ID, Accept: 'application/json' },
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    failure = failureText(err);
  } finally {
    clearTimeout(timeout);
  }
  // Safe words only (see failureText), and thrown out here, not from the
  // catch, so the original error is not carried along as the cause: its text
  // can hold the address above.
  throw new Error(`The player could not be reached: ${failure}`);
}
