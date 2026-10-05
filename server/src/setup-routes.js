// First-run setup, the optional access PIN, and owner-only settings.
//
// Setup used to mean finding a Plex token in a hidden settings page and typing
// it into a file. Now the app asks Plex for a short code, the person enters it
// at plex.tv/link, and the app receives its own token, which is how every
// Plex app signs in. API keys, the PIN and who watches here are asked for on
// the same screen.
//
// Who may do what is decided in auth.js: anyone who can view may browse;
// only the owner may change anything here.

import {
  getClientId,
  isSetupComplete,
  downloadsEnabled,
  lanAccessEnabled,
  updateConfig,
  pinEnabled,
  setPin,
  checkPin,
  checkOwnerCode,
  getOwnerCode,
} from './config.js';
import { bindHost, isLoopbackHost, isDesktop, getLanUrls } from './listen-address.js';
import { listProfiles, createProfile, updateProfile } from './profiles.js';
import {
  canView,
  canChange,
  isOwner,
  isLocal,
  grantSession,
  revokeViewerSessions,
  revokeOtherSessions,
  guessWait,
  recordWrongGuess,
  recordRightGuess,
} from './auth.js';
import { approvedTvs } from './config.js';
import { readJsonWithin } from './plex-fetch.js';
import { discoverRenderers, renderersWithId, isApprovedTv, approveTv, removeApprovedTv } from './tv.js';

const PLEX_HEADERS = () => ({
  Accept: 'application/json',
  'X-Plex-Product': 'Heldover',
  'X-Plex-Client-Identifier': getClientId(),
});

// Routes open to everyone. The TV and download links carry their own
// single-purpose tickets and a TV cannot type a PIN; the sign-in routes
// obviously cannot require being signed in; Docker's health check reports
// memory use and a title count, nothing personal.
const OPEN_API = [
  /^\/auth\//,
  /^\/health\/memory$/,
  /^\/tv\/stream\//,
  /^\/tv\/file\//,
  /^\/download\/file\//,
];

/** Everything under /api needs the PIN when one is set, except the routes above. */
export function accessGate(req, res, next) {
  if (OPEN_API.some((pattern) => pattern.test(req.path))) return next();
  if (canView(req)) return next();
  res.status(401).json({ error: 'Enter the PIN to use Heldover', pinRequired: true });
}

function requireOwner(req, res, next) {
  if (isOwner(req)) return next();
  res.status(403).json({
    error: 'Only the owner can change settings. Enter the settings code on this device first. Heldover prints it when it starts, and shows it in Settings on the computer it runs on.',
    ownerRequired: true,
  });
}

async function plexFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...PLEX_HEADERS(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs || 15000),
  });
  if (!res.ok) {
    const err = new Error(`plex.tv answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // plex.tv's sign-in answers are a few hundred bytes; the limit is the same
  // one the rest of the app puts on small answers.
  return readJsonWithin(res, 8 * 1024 * 1024);
}

// Plex sign-in codes this server asked for. Only these may complete a
// sign-in: otherwise a page could hand in a code that someone else authorised
// and quietly swap which Plex account the app uses.
const PIN_TTL_MS = 20 * 60 * 1000;
const issuedPlexPins = new Map();

function rememberPlexPin(id) {
  const now = Date.now();
  for (const [key, at] of issuedPlexPins) if (now - at > PIN_TTL_MS) issuedPlexPins.delete(key);
  issuedPlexPins.set(String(id), now);
}

/** A PIN or code as typed: a short string or number, nothing else. */
function typed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length <= 200 ? value : null;
}

/**
 * @param {import('express').Express} app
 * @param {{ onPlexConnected: () => void, onKeysChanged: () => void }} hooks
 */
export function registerSetupRoutes(app, { onPlexConnected, onKeysChanged }) {
  // ---------- Status (local only, answers instantly) ----------

  app.get('/api/auth/status', (req, res) => {
    res.json({
      pinEnabled: pinEnabled(),
      signedIn: canView(req),
      canChange: canChange(req),
      isOwner: isOwner(req),
      setupComplete: isSetupComplete(),
      downloadsEnabled: downloadsEnabled(),
    });
  });

  // ---------- Viewing PIN ----------

  app.post('/api/auth/pin', (req, res) => {
    const wait = guessWait(req);
    if (wait) return res.status(429).json({ error: `Too many wrong tries. Try again in ${wait} seconds.` });
    const pin = typed(req.body?.pin);
    if (!pin || !checkPin(pin)) {
      recordWrongGuess(req);
      return res.status(401).json({ error: 'That PIN is not right' });
    }
    recordRightGuess(req);
    grantSession(req, res, 'viewer');
    res.json({ ok: true });
  });

  // ---------- Becoming the owner on another device ----------

  // Wrong settings codes are counted apart from wrong PINs ('code'), so PIN
  // guessing by other devices cannot keep the owner from signing in here.
  app.post('/api/auth/claim', (req, res) => {
    const wait = guessWait(req, 'code');
    if (wait) return res.status(429).json({ error: `Too many wrong tries. Try again in ${wait} seconds.` });
    const code = typed(req.body?.code);
    if (!code || !checkOwnerCode(code)) {
      recordWrongGuess(req, 'code');
      return res.status(401).json({ error: 'That settings code is not right' });
    }
    recordRightGuess(req, 'code');
    grantSession(req, res, 'owner');
    res.json({ ok: true });
  });

  app.post('/api/auth/sign-out-others', requireOwner, (req, res) => {
    revokeOtherSessions(req);
    res.json({ ok: true });
  });

  // ---------- Setup ----------

  /** Everything the setup and settings screens show. Owner only: it names the Plex account. */
  app.get('/api/setup/status', requireOwner, async (req, res) => {
    let plexUser = null;
    if (process.env.PLEX_TOKEN) {
      try {
        const user = await plexFetch('https://plex.tv/api/v2/user', {
          headers: { 'X-Plex-Token': process.env.PLEX_TOKEN },
          timeoutMs: 5000,
        });
        plexUser = user.username || user.title || 'your Plex account';
      } catch {
        plexUser = null;
      }
    }
    res.json({
      setupComplete: isSetupComplete(),
      plexConnected: Boolean(plexUser),
      plexUser,
      tmdbConfigured: Boolean(process.env.TMDB_API_KEY),
      omdbConfigured: Boolean(process.env.OMDB_API_KEY),
      mdblistConfigured: Boolean(process.env.MDBLIST_API_KEY),
      fanartConfigured: Boolean(process.env.FANART_API_KEY),
      pinEnabled: pinEnabled(),
      downloadsEnabled: downloadsEnabled(),
      isLocal: isLocal(req),
      profiles: listProfiles().map(({ id, name, emoji }) => ({ id, name, emoji })),
      desktop: isDesktop(),
      lanAccess: lanAccessEnabled(),
      lanUrls: getLanUrls(),
      // The settings code is what makes another device an owner, so it is only
      // ever shown on the computer Heldover runs on (which is the owner
      // already). A remote owner is not sent it: a borrowed phone that was let
      // in once should not be able to read out the code and let others in.
      ownerCode: isLocal(req) ? getOwnerCode() : undefined,
    });
  });

  /** Ask plex.tv for a code to show the person. */
  app.post('/api/setup/plex/pin', requireOwner, async (req, res) => {
    try {
      const pin = await plexFetch('https://plex.tv/api/v2/pins?strong=false', { method: 'POST' });
      rememberPlexPin(pin.id);
      res.json({ id: pin.id, code: pin.code, expiresIn: pin.expiresIn || 900, linkUrl: 'https://plex.tv/link' });
    } catch (err) {
      res.status(502).json({ error: `Could not reach plex.tv: ${err.message}` });
    }
  });

  /** Has the person entered the code yet? The client asks every few seconds. */
  app.post('/api/setup/plex/pin/:id/check', requireOwner, async (req, res) => {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id) || !issuedPlexPins.has(id)) {
      return res.status(410).json({ error: 'That code expired. Get a new one.' });
    }
    try {
      const pin = await plexFetch(`https://plex.tv/api/v2/pins/${id}`);
      if (!pin.authToken) return res.json({ connected: false });
      issuedPlexPins.delete(id);
      updateConfig({ plexToken: pin.authToken });
      onPlexConnected();
      res.json({ connected: true });
    } catch (err) {
      // Only "not found" means the code is gone. Anything else is plex.tv
      // having a moment, and the page should keep waiting.
      if (err.status === 404) {
        issuedPlexPins.delete(id);
        return res.status(410).json({ error: 'That code expired. Get a new one.' });
      }
      res.status(502).json({ error: 'plex.tv did not answer, still waiting', retry: true });
    }
  });

  /** For people who would rather paste a token they already have. */
  app.post('/api/setup/plex/token', requireOwner, async (req, res) => {
    const token = (typed(req.body?.token) || '').trim();
    if (!token) return res.status(400).json({ error: 'Paste a token first' });
    try {
      await plexFetch('https://plex.tv/api/v2/user', { headers: { 'X-Plex-Token': token } });
    } catch {
      return res.status(400).json({ error: 'Plex did not accept that token' });
    }
    updateConfig({ plexToken: token });
    onPlexConnected();
    res.json({ connected: true });
  });

  /** API keys. TMDB is checked before it is saved; the others are optional extras. */
  app.post('/api/setup/keys', requireOwner, async (req, res) => {
    const patch = {};
    const body = req.body || {};
    if (typeof body.tmdbApiKey === 'string' && body.tmdbApiKey.trim()) {
      const key = body.tmdbApiKey.trim();
      try {
        const check = await fetch(
          `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (!check.ok) return res.status(400).json({ error: 'TMDB did not accept that key' });
      } catch {
        return res.status(502).json({ error: 'Could not reach TMDB to check the key' });
      }
      patch.tmdbApiKey = key;
    }
    for (const key of ['omdbApiKey', 'mdblistApiKey', 'fanartApiKey']) {
      if (typeof body[key] === 'string' && body[key].length <= 200) patch[key] = body[key];
    }
    updateConfig(patch);
    // Workers that fetch extra ratings start at boot and give up when a key is
    // missing; a key added later has to wake them, or it silently does nothing.
    onKeysChanged();
    res.json({ ok: true });
  });

  /**
   * Turn the viewing PIN on or change it ({ pin: "123456" }), or turn it off
   * ({ pin: null }). The field must be present: an empty or unreadable body
   * used to count as "off".
   */
  app.post('/api/setup/access-pin', requireOwner, (req, res) => {
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'pin')) {
      return res.status(400).json({ error: 'Send { "pin": "..." } or { "pin": null }' });
    }
    try {
      const pin = req.body.pin === null ? null : typed(req.body.pin);
      if (req.body.pin !== null && !pin) return res.status(400).json({ error: 'The PIN must be 6 to 12 digits' });
      setPin(pin);
      revokeViewerSessions();
      res.json({ ok: true, pinEnabled: pinEnabled() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/setup/downloads', requireOwner, (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Send { "enabled": true|false }' });
    updateConfig({ downloadsEnabled: req.body.enabled });
    res.json({ ok: true, downloadsEnabled: downloadsEnabled() });
  });

  /**
   * The desktop app's "let phones and other devices connect" switch. The
   * listen address is chosen before the server starts, so a change only takes
   * effect on a restart: the desktop app (this process's parent) is asked for
   * one once the answer has gone out, and it reloads its window afterwards.
   */
  app.post('/api/setup/lan-access', requireOwner, (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Send { "enabled": true|false }' });
    if (!isDesktop()) {
      return res.status(400).json({
        error: 'This switch is only for the desktop app. Here, the address Heldover listens on is set with BIND_HOST.',
      });
    }
    updateConfig({ lanAccess: req.body.enabled });
    // Compared with how the server is listening right now, not with the saved
    // setting, so asking again after a restart that failed still restarts.
    const restartRequired = req.body.enabled === isLoopbackHost(bindHost());
    if (restartRequired && typeof process.send === 'function') {
      res.on('finish', () => process.send({ type: 'restart-server' }));
    }
    res.json({ ok: true, lanAccess: lanAccessEnabled(), restartRequired });
  });

  // ---------- TVs other devices may cast to ----------
  //
  // The owner can cast to any TV on the network. Every other device can only
  // use the TVs approved here (see tv.js for why).

  /** A TV's id as sent by the settings screen: a short string, nothing else. */
  const tvId = (value) => (typeof value === 'string' && value && value.length <= 2000 ? value : null);

  /** The approved TVs, and the TVs on the network now, each marked approved or not. */
  app.get('/api/setup/tvs', requireOwner, async (req, res) => {
    try {
      const discovered = (await discoverRenderers()).map(({ id, name, model, host }) => ({
        id,
        name,
        model,
        host,
        approved: isApprovedTv({ id, host }),
      }));
      res.json({ approved: approvedTvs(), discovered });
    } catch {
      res.status(500).json({ error: 'Could not look for TVs on your network. Try again.' });
    }
  });

  /**
   * Approve a TV by its id. Only a TV that discovery has found: its name and
   * address come from what the TV itself answered, never from this request.
   */
  app.post('/api/setup/tvs/approve', requireOwner, async (req, res) => {
    const id = tvId(req.body?.id);
    if (!id) return res.status(400).json({ error: 'Send { "id": "..." }' });
    try {
      const found = await renderersWithId(id);
      if (found.length === 0) {
        return res.status(400).json({ error: 'That TV was not found on your network. Make sure it is switched on, then look again.' });
      }
      // Two devices giving the same id: one of them is copying the other, and
      // this request cannot say which one the owner means.
      if (found.length > 1) {
        return res.status(409).json({
          error: 'More than one device on your network answers as that TV. Switch off the one you do not recognize, then look again.',
        });
      }
      approveTv(found[0]);
      res.json({ ok: true, approved: approvedTvs() });
    } catch {
      res.status(500).json({ error: 'Could not approve that TV. Try again.' });
    }
  });

  app.post('/api/setup/tvs/remove', requireOwner, (req, res) => {
    const id = tvId(req.body?.id);
    if (!id) return res.status(400).json({ error: 'Send { "id": "..." }' });
    removeApprovedTv(id);
    res.json({ ok: true, approved: approvedTvs() });
  });

  /**
   * Who watches here. The first name renames the starter profile; the rest are
   * added. Only during setup: afterwards profiles are managed in the switcher.
   */
  app.post('/api/setup/profiles', requireOwner, (req, res) => {
    if (isSetupComplete()) return res.status(409).json({ error: 'Setup is already finished' });
    const names = (Array.isArray(req.body?.names) ? req.body.names : [])
      .map((n) => String(n || '').trim().slice(0, 40))
      .filter(Boolean);
    const unique = [...new Set(names)].slice(0, 8);
    if (unique.length === 0) return res.status(400).json({ error: 'Add at least one name' });
    try {
      const existing = listProfiles();
      updateProfile(existing[0].id, { name: unique[0] });
      const taken = new Set(listProfiles().map((p) => p.name));
      for (const name of unique.slice(1)) if (!taken.has(name)) createProfile(name);
      res.json({ ok: true, profiles: listProfiles() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/setup/complete', requireOwner, (req, res) => {
    if (!process.env.PLEX_TOKEN) return res.status(400).json({ error: 'Sign in to Plex first' });
    updateConfig({ setupComplete: true });
    res.json({ ok: true });
  });
}
