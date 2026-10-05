// Checks the environment variables once, at startup, before anything reads them.
//
// These come from people typing into a Docker compose file or a shell, so the
// usual mistakes are "true" where "1" was meant, a port with a typo, or a key
// pasted with a trailing space. Left alone, those fail far from their cause (a
// NaN daily limit quietly stops all OMDb lookups). Here a bad value is named in
// the log and replaced by its default. Two things stop startup instead: a data
// folder the app cannot write, because nothing works without one, and a
// BIND_HOST it cannot use, because the default for that one is the widest
// setting there is.

import fs from 'fs';
import net from 'net';

const problems = [];

function drop(name, reason) {
  problems.push(`${name}=${JSON.stringify(process.env[name])} ignored: ${reason}`);
  delete process.env[name];
}

function checkInteger(name, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    drop(name, `expected a whole number from ${min} to ${max}`);
  } else {
    process.env[name] = String(value);
  }
}

function checkSwitch(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) process.env[name] = '1';
  else if (['0', 'false', 'no', 'off'].includes(value)) delete process.env[name];
  else drop(name, 'expected 1 or 0');
}

function checkUrl(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    process.env[name] = url.origin;
  } catch {
    drop(name, 'expected an http:// or https:// address');
  }
}

// BIND_HOST limits who can reach the app. A value that cannot be used must not
// fall back to the default, because the default is every adapter: someone who
// wrote "localhost" or "127.0.0.1:3001" to keep the app to this computer got
// the whole network instead. "localhost" is taken as this computer only
// (127.0.0.1); only spaces counts as not set; anything else that is not an IP
// address stops startup, the same as a data folder that cannot be written.
function checkIpAddress(name) {
  const raw = process.env[name];
  if (raw === undefined) return;
  const value = raw.trim();
  if (value === '') {
    delete process.env[name];
    return;
  }
  if (value.toLowerCase() === 'localhost') {
    process.env[name] = '127.0.0.1';
    return;
  }
  if (net.isIP(value) === 0) {
    console.error(`${name}=${JSON.stringify(raw)} is not an IP address.`);
    console.error(
      'Heldover will not start, because the default would open it to every device on the network. Use 127.0.0.1 for this computer only, or 0.0.0.0 for every device.'
    );
    process.exit(1);
  }
  process.env[name] = value;
}

checkInteger('PORT', 1, 65535);
checkIpAddress('BIND_HOST');
checkInteger('CLIENT_PORT', 1, 65535);
checkInteger('OMDB_DAILY_LIMIT', 1, 10_000_000);
checkInteger('MDBLIST_DAILY_LIMIT', 1, 10_000_000);
checkSwitch('DISABLE_MDNS');
checkSwitch('RESET_PIN');
checkSwitch('PLEX_ALLOW_HTTP');
checkUrl('GOPEED_URL');

for (const name of ['PLEX_TOKEN', 'TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY']) {
  if (process.env[name] !== undefined) process.env[name] = process.env[name].trim();
}

if (process.env.MDNS_NAME && !/^[a-z0-9-]{1,63}$/i.test(process.env.MDNS_NAME.trim())) {
  drop('MDNS_NAME', 'use letters, digits and hyphens only');
}

if (process.env.FFMPEG_PATH && !fs.existsSync(process.env.FFMPEG_PATH)) {
  drop('FFMPEG_PATH', 'no file there; looking for ffmpeg in the usual places instead');
}

if (process.env.DATA_DIR) {
  try {
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    fs.accessSync(process.env.DATA_DIR, fs.constants.W_OK);
  } catch (err) {
    console.error(`DATA_DIR ${process.env.DATA_DIR} cannot be written (${err.code || err.message}).`);
    console.error('Heldover keeps its database there, so it cannot start. Fix the folder permissions or point DATA_DIR elsewhere.');
    process.exit(1);
  }
}

for (const line of problems) console.warn(`Setting ${line}`);
