// Who may use this install, and who may change it.
//
// Three kinds of trust, deliberately separate:
//
//   Viewing   anyone on the network, unless the owner set a PIN, in which case
//             a device must enter it once.
//   Changing  rating, hiding, queueing, swiping, casting, downloading. A
//             device that entered the PIN, or the owner. With no PIN set,
//             only the owner: everyone else can look but not touch.
//   Owning    changing the Plex account, keys, PIN or downloads. Only the
//             computer Heldover runs on, or a device that has entered the
//             settings code printed in the log. A PIN does not make someone an
//             owner: without this split, any device on the Wi-Fi could set a
//             PIN of its own and lock the real owner out.
//
// Sessions are random per device and stored hashed, so one device can be
// signed out without the others, and a copied cookie is not a skeleton key.

import crypto from 'crypto';
import { openRatingsDb } from './db.js';
import { pinEnabled } from './config.js';

const db = openRatingsDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('viewer', 'owner')),
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  )
`);

const insertSession = db.prepare('INSERT INTO auth_sessions (id_hash, kind) VALUES (?, ?)');
const selectSession = db.prepare('SELECT kind FROM auth_sessions WHERE id_hash = ?');
const touchSession = db.prepare("UPDATE auth_sessions SET last_seen = datetime('now') WHERE id_hash = ?");
const deleteViewerSessions = db.prepare("DELETE FROM auth_sessions WHERE kind = 'viewer'");
const deleteAllExcept = db.prepare('DELETE FROM auth_sessions WHERE id_hash != ?');
const deleteStale = db.prepare("DELETE FROM auth_sessions WHERE last_seen < datetime('now', '-400 days')");

const COOKIE = 'pp_session';
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function readCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** The session kind this request carries, or null. */
function sessionKind(req) {
  if (req._sessionKind !== undefined) return req._sessionKind;
  const raw = readCookie(req);
  let kind = null;
  if (raw && /^[0-9a-f]{64}$/.test(raw)) {
    const idHash = hash(raw);
    const row = selectSession.get(idHash);
    if (row) {
      kind = row.kind;
      touchSession.run(idHash);
    }
  }
  req._sessionKind = kind;
  return kind;
}

/**
 * Starts a session for this device. An owner session is never downgraded to
 * a viewer one by entering the PIN afterwards.
 */
export function grantSession(req, res, kind) {
  if (kind === 'viewer' && sessionKind(req) === 'owner') return;
  deleteStale.run();
  const raw = crypto.randomBytes(32).toString('hex');
  insertSession.run(hash(raw), kind);
  // Secure only when the request actually arrived over https (a reverse proxy
  // the owner configured with TRUST_PROXY); plain http on a home network
  // would otherwise never send the cookie back.
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure}`
  );
  req._sessionKind = kind;
}

/** Changing the PIN signs out everyone who got in with the old one. */
export function revokeViewerSessions() {
  deleteViewerSessions.run();
}

/** "Sign out every other device", keeping the one that asked. */
export function revokeOtherSessions(req) {
  const raw = readCookie(req);
  deleteAllExcept.run(raw ? hash(raw) : '');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * A request from the computer Heldover runs on. That is the desktop app,
 * or someone at that machine, who can read its files and logs anyway.
 *
 * Decided from the connection itself, never from what a request says about
 * where it came from. This used to follow req.ip when TRUST_PROXY was set, and
 * with TRUST_PROXY=1 Express takes the forwarded address from the first hop
 * whoever that is: a device connecting straight to the app with
 * "X-Forwarded-For: 127.0.0.1" became the owner and could remove the PIN.
 *
 * So: the connection must come from this machine, and if a proxy on this
 * machine forwarded it, the address the proxy recorded last (the one it saw
 * itself, which a client cannot forge) must be this machine too. A visitor
 * arriving through a reverse proxy is therefore never local; they claim
 * ownership with the settings code like any other device.
 */
export function isLocal(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return false;
  if (req.headers?.forwarded) return false;
  const forwarded = req.headers?.['x-forwarded-for'];
  if (!forwarded) return true;
  const hops = String(forwarded).split(',').map((h) => h.trim()).filter(Boolean);
  return hops.length > 0 && LOOPBACK.has(hops[hops.length - 1]);
}

export function isOwner(req) {
  return isLocal(req) || sessionKind(req) === 'owner';
}

export function canView(req) {
  return !pinEnabled() || isLocal(req) || sessionKind(req) !== null;
}

/**
 * May this device change anything: rate, hide, queue, swipe, cast, download?
 * Only one that has proved itself, with the PIN or as the owner. Without a
 * PIN nobody but the owner has proved anything, so every other device on the
 * network can look around and nothing more. Before this, a guest's phone could
 * start playback on the TV and edit the owner's plex.tv watchlist.
 *
 * A PIN session only counts while a PIN is set: one left over from a PIN that
 * was since removed proves nothing.
 */
export function canChange(req) {
  if (isOwner(req)) return true;
  return pinEnabled() && sessionKind(req) === 'viewer';
}

// ---------- Guess limits ----------
//
// Per address: five wrong tries lock that address out for five minutes.
// Overall: twenty wrong tries in fifteen minutes, from anywhere, pause all
// guessing for fifteen minutes, so a device that keeps changing its address
// gains nothing. The computer Heldover runs on is never locked out, so the
// owner always has a way in.
//
// The settings code is counted apart from the PINs. With one count for
// everything, twenty wrong PIN tries from two devices also paused the
// settings code, and that is the owner's only way in from another device
// (and the only way in at all in Docker or behind a proxy, where nothing
// counts as "this computer"). So a guest could keep the owner out by
// mistyping a PIN. Each secret now has its own per-address count and its own
// overall count. The PIN's limits are exactly what they were: a PIN is short
// and needs them. The settings code keeps an overall limit too, a larger one:
// it has about a million million possibilities, so 300 tries per pause
// protects it far better than 20 protect a six-digit PIN, and it takes
// twenty addresses guessing flat out for fifteen minutes to reach, not two.
// Keeping the counts apart also means a right PIN no longer wipes the same
// device's wrong tries at the settings code.

const PER_ADDRESS_MAX = 5;
const PER_ADDRESS_LOCK_MS = 5 * 60 * 1000;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_MAX = 20;
const CODE_GLOBAL_MAX = 300;

const newCounts = (name, globalMax) => ({ name, globalMax, byAddress: new Map(), globalFailures: [], globalLockUntil: 0 });
const counts = {
  // The viewing PIN, and the edit PIN of a shared view.
  pin: newCounts('PIN', GLOBAL_MAX),
  code: newCounts('settings code', CODE_GLOBAL_MAX),
};
// Anything that does not say which secret it guards is counted with the
// PINs, the strict one.
const countsFor = (secret) => (Object.hasOwn(counts, secret) ? counts[secret] : counts.pin);

function prune(now) {
  for (const c of Object.values(counts)) {
    c.globalFailures = c.globalFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
    for (const [key, entry] of c.byAddress) {
      if (entry.until < now && now - entry.last > GLOBAL_WINDOW_MS) c.byAddress.delete(key);
    }
  }
}

/**
 * Seconds to wait before another guess is allowed, or 0.
 * `secret` is 'pin' (the viewing PIN or a view's edit PIN) or 'code' (the
 * settings code); each has its own counts.
 */
export function guessWait(req, secret = 'pin') {
  if (isLocal(req)) return 0;
  const now = Date.now();
  prune(now);
  const c = countsFor(secret);
  const entry = c.byAddress.get(req.ip);
  const until = Math.max(entry?.until || 0, c.globalLockUntil);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

export function recordWrongGuess(req, secret = 'pin') {
  if (isLocal(req)) return;
  const now = Date.now();
  const c = countsFor(secret);
  const entry = c.byAddress.get(req.ip) || { count: 0, until: 0, last: 0 };
  entry.count += 1;
  entry.last = now;
  if (entry.count >= PER_ADDRESS_MAX) {
    entry.until = now + PER_ADDRESS_LOCK_MS;
    entry.count = 0;
  }
  c.byAddress.set(req.ip, entry);
  c.globalFailures.push(now);
  if (c.globalFailures.length >= c.globalMax) {
    c.globalLockUntil = now + GLOBAL_WINDOW_MS;
    c.globalFailures = [];
    // Said once, when the pause starts, so the owner can see why a right
    // entry is being turned away.
    console.log(
      `[access] ${c.globalMax} wrong ${c.name} tries in 15 minutes: entering the ${c.name} is paused for 15 minutes on every device except the computer Heldover runs on. Devices that are already signed in keep working.`
    );
  }
}

export function recordRightGuess(req, secret = 'pin') {
  countsFor(secret).byAddress.delete(req.ip);
}

// ---------- Where requests may come from ----------

const allowedExtraHosts = new Set(
  String(process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Names a home network uses. A web page can point its own domain name at this
 * machine ("DNS rebinding") and then talk to the app as if it were the app's
 * own page; its requests arrive naming the attacker's domain, which is not on
 * this list. Public domains in front of a reverse proxy go in ALLOWED_HOSTS.
 */
function hostAllowed(hostHeader) {
  if (!hostHeader) return true;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (allowedExtraHosts.has(hostname)) return true;
  if (hostname === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true; // IPv4
  if (hostname.startsWith('[')) return true; // IPv6 literal
  if (!hostname.includes('.')) return true; // a single-label machine name
  return /\.(local|lan|home|home\.arpa|internal|localdomain|ts\.net)$/.test(hostname);
}

const CHANGES_STATE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Applied to every /api request. Rejects requests addressed to a foreign
 * domain, and state changes sent from another site (another port on the same
 * machine counts as another site: a browser sends the page's origin along,
 * and it will not match this app's).
 */
export function requestGuard(req, res, next) {
  if (!hostAllowed(req.headers.host)) {
    return res.status(421).json({
      error: 'This address is not allowed. If you reach Heldover through your own domain, add it to ALLOWED_HOSTS.',
    });
  }
  if (CHANGES_STATE.has(req.method) && req.headers.origin) {
    let originHost;
    try {
      originHost = new URL(req.headers.origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    const forwardedHost = req.app?.get('trust proxy') ? req.headers['x-forwarded-host'] : null;
    const expected = String(forwardedHost || req.headers.host || '').toLowerCase();
    if (!originHost || originHost !== expected) {
      return res.status(403).json({ error: 'Requests from other sites are not accepted' });
    }
  }
  next();
}
