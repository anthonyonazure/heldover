// Settings the app changes about itself: the Plex sign-in, API keys, the
// optional access PIN, and switches such as downloads.
//
// Environment variables used to be the only way in, which meant editing a file
// before the app would start. That is fine for whoever wrote it and a wall for
// anyone else, and a Docker container has no file to edit at all. So the setup
// screen writes here instead, and the values are copied into process.env at
// startup, so every part of the server that already reads the environment keeps
// working unchanged.
//
// Stored as a small JSON file beside the database, readable only by this user.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from './db.js';

const FILE = path.join(DATA_DIR, 'config.json');

/** Setting name → the environment variable the rest of the server reads. */
const ENV_KEYS = {
  plexToken: 'PLEX_TOKEN',
  tmdbApiKey: 'TMDB_API_KEY',
  omdbApiKey: 'OMDB_API_KEY',
  mdblistApiKey: 'MDBLIST_API_KEY',
  fanartApiKey: 'FANART_API_KEY',
};

// A file that is absent is a new install. A file that is there but cannot be
// read or parsed is not: starting with blank settings would remove the access
// PIN and the Plex sign-in, and the save below would then destroy the old file.
// So startup stops, the same as for a data folder that cannot be written, and
// the file is left exactly as it was found.
function stop(what) {
  console.error(`The settings file ${FILE} ${what}.`);
  console.error(
    'Heldover will not start with blank settings, because that would remove the access PIN and the Plex sign-in. Repair the file or its permissions. To start again with new settings on purpose, move the file away.'
  );
  process.exit(1);
}

function load() {
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return stop(`cannot be read (${err.code || err.message})`);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Reported below, with an empty file and a file that holds something else.
  }
  return stop('is empty or damaged');
}

function save() {
  const temp = `${FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
    // On disk before the rename replaces the old file: a power cut between the
    // two must not leave an empty settings file behind.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, FILE);
}

let config = load();

if (!config) {
  // No settings file. A folder that already has a database, with a Plex token
  // supplied through the environment, is an install that was in use: its
  // settings file was moved away (the stop message above says to do that),
  // deleted or left out of a restore, or it comes from a version older than
  // the settings file. Its owner finished setup long ago, so the setup screen
  // is not shown again. Everything else is a new install and starts at the
  // setup screen, even when a Plex token was supplied through the environment
  // (as Docker users may do).
  //
  // Downloads start off in every case. This start used to switch them on for
  // the first kind, taking it for an upgrade from a version that had no
  // switch. But nothing here can tell that from a settings file that went
  // missing, and that one may have had downloads off: only the owner turns
  // them on, in Settings, never a start.
  const usedBefore =
    Boolean(process.env.PLEX_TOKEN) && fs.existsSync(path.join(DATA_DIR, 'ratings.db'));
  config = {
    setupComplete: usedBefore,
    downloadsEnabled: false,
  };
  if (usedBefore) {
    console.log(
      '[settings] The settings file was missing, so Heldover made a new one with downloads switched off and no access PIN. To switch downloads on again, open Settings on the computer that runs Heldover.'
    );
  }
}

// Plex lists every app that signs in as a device, keyed by this id, and a
// sign-in started from the setup screen is collected from plex.tv by naming
// it. So it has to be this install's own. Older installs all carried the same
// fixed id ("plex-picker", the app's working name, which anyone can read in
// this source). One of those, or a settings file with no id at all, is given
// its own here, once, and keeps it from then on. getClientId() is the only
// place the rest of the server reads it from.
const SHARED_CLIENT_ID = 'plex-picker';
if (typeof config.clientId !== 'string' || !config.clientId.trim() || config.clientId === SHARED_CLIENT_ID) {
  config.clientId = `heldover-${crypto.randomUUID()}`;
}

// Signs nothing any more (sessions are random and stored), kept for installs
// that already have it.
if (!config.secret) config.secret = crypto.randomBytes(32).toString('hex');

// Signs the picture addresses this install hands out (plex-images.js), so the
// picture route serves only an address the app itself issued. Random, made
// once here and kept from then on; it has nothing to do with the access PIN,
// so setting, changing or clearing the PIN leaves every picture address as it
// was. It is never sent to a browser and never written to the log. Without
// this file a new key is made, and the addresses kept in the database are
// signed again with it at that start (picture-addresses.js).
if (typeof config.pictureKey !== 'string' || !/^[0-9a-f]{64}$/.test(config.pictureKey)) {
  config.pictureKey = crypto.randomBytes(32).toString('hex');
}

// The settings code: proves someone is the owner of this install from a
// device other than the one it runs on. Printed in the log at every start,
// which only the owner can read. Unambiguous letters, grouped for reading.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newOwnerCode() {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
if (!config.ownerCode) config.ownerCode = newOwnerCode();

// A forgotten PIN is cleared by starting once with RESET_PIN=1.
if (process.env.RESET_PIN === '1' && config.pinHash) {
  delete config.pinHash;
  delete config.pinSalt;
  console.log('[access] RESET_PIN=1: the access PIN has been removed.');
}
save();

// Values saved from the setup screen win over the environment, because they
// are the more recent choice; anything not saved here falls through to it.
for (const [key, envName] of Object.entries(ENV_KEYS)) {
  if (config[key]) process.env[envName] = config[key];
}

export function getClientId() {
  return config.clientId;
}

/** The key that signs picture addresses. For plex-images.js only: never put it in an answer or a log line. */
export function getPictureKey() {
  return config.pictureKey;
}

export function isSetupComplete() {
  return Boolean(config.setupComplete);
}

export function downloadsEnabled() {
  return Boolean(config.downloadsEnabled);
}

/**
 * The desktop app's "let phones and other devices connect" switch. Off until
 * the owner turns it on. The desktop app reads this from config.json before it
 * starts the server, and picks the listen address from it; Docker and
 * run-from-source installs use BIND_HOST instead.
 */
export function lanAccessEnabled() {
  return config.lanAccess === true;
}

/**
 * The TVs the owner has approved, each { id, name, host }: the id the TV
 * gives itself and the address it answered from. A device that is not the
 * owner may only cast to these (see tv.js). Saved with
 * updateConfig({ approvedTvs: [...] }).
 */
export function approvedTvs() {
  return (Array.isArray(config.approvedTvs) ? config.approvedTvs : [])
    .filter((tv) => tv && typeof tv.id === 'string' && tv.id && typeof tv.host === 'string' && tv.host)
    .map(({ id, name, host }) => ({ id, name: typeof name === 'string' && name ? name : 'TV', host }));
}

/** Only the known settings can be changed, and secrets go to the environment too. */
export function updateConfig(patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (key in ENV_KEYS) {
      const clean = typeof value === 'string' ? value.trim() : '';
      config[key] = clean || undefined;
      if (clean) process.env[ENV_KEYS[key]] = clean;
      else delete process.env[ENV_KEYS[key]];
    } else if (key === 'downloadsEnabled' || key === 'setupComplete' || key === 'lanAccess') {
      config[key] = Boolean(value);
    } else if (key === 'approvedTvs') {
      config.approvedTvs = Array.isArray(value) ? value : [];
      config.approvedTvs = approvedTvs();
    }
  }
  save();
}

// ---------- Access PIN ----------

export function pinEnabled() {
  return Boolean(config.pinHash);
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

/** A PIN of 6 to 12 digits, or null to turn the PIN off. */
export function setPin(pin) {
  if (pin === null) {
    delete config.pinHash;
    delete config.pinSalt;
  } else {
    // Six digits: a million possibilities. Four could be walked in days even
    // with lockouts, by a device that keeps changing its address.
    if (!/^\d{6,12}$/.test(String(pin))) throw new Error('The PIN must be 6 to 12 digits');
    config.pinSalt = crypto.randomBytes(16).toString('hex');
    config.pinHash = hashPin(pin, config.pinSalt);
  }
  save();
}

export function checkPin(pin) {
  if (!pinEnabled() || typeof pin !== 'string') return false;
  const given = Buffer.from(hashPin(pin, config.pinSalt), 'hex');
  const stored = Buffer.from(config.pinHash, 'hex');
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}

/** Compares a code typed by a person with the settings code. */
export function checkOwnerCode(code) {
  if (typeof code !== 'string') return false;
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const given = Buffer.from(clean);
  const expected = Buffer.from(config.ownerCode.replace('-', ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function getOwnerCode() {
  return config.ownerCode;
}
