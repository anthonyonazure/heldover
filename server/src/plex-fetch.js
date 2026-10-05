// Requests to a Plex server or player stay on the address they were sent to.
//
// The address of a file, a picture or a player comes from the other side: a
// Plex server that may belong to someone else, or a device on the network. Two
// things let that side move a request, and the token that travels with it, to
// a machine of its choosing: an address that names another host outright, and
// an answer that redirects there (fetch follows redirects without being asked).
// Everything addressed to a Plex server or player goes through here, so
// neither works: the address is checked before the request, and a redirect is
// followed only when it stays on the same origin.

export class OffOriginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OffOriginError';
  }
}

const MAX_HOPS = 3;

// ---------- How much of an answer is read ----------
//
// plexFetch hands the answer back unread, and nearly every caller then reads
// it whole with res.json(). fetch has no size limit of its own, so the server
// that answered (often someone else's) chose how much memory that one read
// took, in the one process every device shares. Whole reads of an answer that
// came through here are now counted as the bytes arrive and given up on past
// a limit the app chooses.
//
// The limit is on the reads that hold the whole answer in memory: json, text,
// arrayBuffer, bytes and blob. `res.body` is left exactly as fetch returned
// it. A file passed on to a download or to the TV is read from there, is
// many gigabytes, is never held in memory, and must not be cut off.

export class AnswerTooLargeError extends Error {
  constructor() {
    super('The answer from Plex was too large to read');
    this.name = 'AnswerTooLargeError';
  }
}

/**
 * The most bytes of one answer that are read into memory when the caller
 * names no limit of its own. One library page (500 titles) is a few megabytes
 * and the full episode list of a show that has run for decades is some tens,
 * so this leaves both a wide margin.
 */
export const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
/**
 * For answers that are small by nature: one title, a server's list of
 * sections, who is playing, the account's list of servers. Real ones are a
 * few kilobytes to a few hundred.
 */
export const MAX_SMALL_ANSWER_BYTES = 8 * 1024 * 1024;

// Infinity outside tests. A test lowers it so the limit can be reached with a
// few kilobytes; it then applies on top of whatever limit a caller names.
let ceilingForTests = Infinity;

/** For tests: a limit small enough to reach. Call with nothing to put it back. */
export function setAnswerLimitForTests(maxBytes = Infinity) {
  ceilingForTests = maxBytes;
}

function limitFor(maxAnswerBytes) {
  const asked = Number.isFinite(maxAnswerBytes) && maxAnswerBytes > 0 ? maxAnswerBytes : MAX_ANSWER_BYTES;
  return Math.min(asked, ceilingForTests);
}

/**
 * The whole body of `res`, or AnswerTooLargeError once it passes `maxBytes`.
 * The declared length is looked at first, to give up early. The bytes are
 * then counted as they arrive, because an answer may declare no length or a
 * wrong one. Giving up also closes the connection, so the rest is never sent.
 */
async function bytesWithin(res, maxBytes) {
  const declared = Number(res.headers?.get('content-length'));
  if (declared > maxBytes) {
    res.body.cancel().catch(() => {});
    throw new AnswerTooLargeError();
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not waited for: the server that sent too much does not get to decide
      // when the refusal is reported either.
      reader.cancel().catch(() => {});
      throw new AnswerTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** As res.json() and res.text() read it: UTF-8, without a byte order mark. */
const asText = (bytes) => new TextDecoder().decode(bytes);

/**
 * res.json(), but never more than `maxAnswerBytes` of it (MAX_ANSWER_BYTES
 * when left out). For an answer that did not come through plexFetch: plex.tv
 * is asked with a plain fetch.
 */
export async function readJsonWithin(res, maxAnswerBytes) {
  // A stand-in with no stream to count (some tests) is read its own way.
  if (typeof res?.body?.getReader !== 'function') return res.json();
  return JSON.parse(asText(await bytesWithin(res, limitFor(maxAnswerBytes))));
}

/**
 * Replace the whole-body readers of `res` with ones that count. The methods
 * are set on this one Response; `res.body` and everything else stay as they
 * were, so a caller that streams the body is not limited.
 */
function withCountedReads(res, maxBytes) {
  if (typeof res?.body?.getReader !== 'function') return res;
  const read = () => bytesWithin(res, maxBytes);
  const readers = {
    json: async () => JSON.parse(asText(await read())),
    text: async () => asText(await read()),
    // Copied out: a small Buffer is a window on memory it shares with others.
    arrayBuffer: async () => new Uint8Array(await read()).buffer,
    bytes: async () => new Uint8Array(await read()),
    blob: async () => new Blob([await read()], { type: res.headers.get('content-type') || '' }),
  };
  for (const [name, value] of Object.entries(readers)) {
    Object.defineProperty(res, name, { value, configurable: true, writable: true });
  }
  return res;
}

/**
 * The address of `pathOrUrl` on the server at `base`, or an error when it
 * would land anywhere else. A path ("/library/parts/1/file.mkv") is the
 * normal case; a full address is accepted only if it is that same server.
 * The message never includes the address itself, which can carry a token.
 */
export function sameOriginUrl(base, pathOrUrl) {
  let origin;
  let resolved;
  try {
    origin = new URL(base);
    resolved = new URL(String(pathOrUrl), origin);
  } catch {
    throw new OffOriginError('That is not an address on the Plex server');
  }
  if (!/^https?:$/.test(resolved.protocol) || resolved.origin !== origin.origin) {
    throw new OffOriginError('Refused an address that points away from the Plex server');
  }
  return resolved.toString();
}

/**
 * fetch, for a Plex server or player. A redirect to the same origin is
 * followed (a reverse proxy may tidy an address); a redirect anywhere else is
 * refused, and so is any redirect of a request that is not a plain read.
 * `redirect` cannot be overridden by the caller.
 *
 * `options.maxAnswerBytes` (optional) is the most bytes of the answer that
 * res.json(), res.text() and the other whole-body readers will take before
 * they fail with AnswerTooLargeError. Left out, it is MAX_ANSWER_BYTES. It is
 * not passed on to fetch, and it does not limit `res.body`.
 */
export async function plexFetch(url, options = {}, fetchImpl = fetch) {
  const { maxAnswerBytes, ...fetchOptions } = options;
  let current = new URL(url);
  const { origin } = current;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const res = await fetchImpl(current, { ...fetchOptions, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return withCountedReads(res, limitFor(maxAnswerBytes));
    try {
      await res.body?.cancel();
    } catch {
      // Nothing to release.
    }
    if (method !== 'GET' && method !== 'HEAD') {
      throw new OffOriginError('Refused a redirect of a request that changes something');
    }
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new OffOriginError('Refused a redirect to an unreadable address');
    }
    if (next.origin !== origin) {
      throw new OffOriginError('Refused a redirect away from the Plex server');
    }
    current = next;
  }
  throw new OffOriginError('Refused a chain of redirects');
}
