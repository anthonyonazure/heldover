// Cast to the living-room TV over DLNA, with no Plex app on the TV and no
// pairing prompt.
//
// Plex's own "play on device" needs a Plex client signed into your account,
// advertising itself, and reachable. On shared servers that almost never lines
// up. Every smart TV of the last decade, though, exposes a UPnP MediaRenderer
// that will fetch and play any HTTP URL you hand it, no permission asked. So we
// hand it one.
//
// The catch is codecs: shared libraries are full of DTS-MA and TrueHD audio
// that modern Samsungs refuse to decode, and the TV answers that by silently
// going to STOPPED. `/api/tv/stream` exists to fix exactly that: it relays the
// Plex file through ffmpeg, re-encoding the soundtrack, and re-encoding the
// picture only when the TV cannot decode it (on the hardware encoder where
// there is one).

import dgram from 'dgram';
import os from 'os';
import { existsSync } from 'fs';
import { getLanIp } from './discovery.js';
import { plexId } from './plex-ids.js';
import { isHomeNetworkAddress } from './plex-playback.js';
import { plexFetch, sameOriginUrl } from './plex-fetch.js';
import { isListedItem } from './plex-library.js';
import { approvedTvs, updateConfig } from './config.js';

const AV_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';

// Video the TV plays natively. Anything outside this list gets relayed.
const SAFE_VIDEO_CODECS = new Set(['h264', 'hevc', 'mpeg4', 'vp9', 'av1']);
const SAFE_AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'pcm']);
const SAFE_CONTAINERS = new Set(['mp4', 'mkv', 'mov', 'm4v']);

/**
 * Where ffmpeg lives. Under launchd the PATH is bare — no /opt/homebrew — so
 * looking the binary up by name fails with ENOENT even though it is installed.
 */
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
].filter(Boolean);

let ffmpegPath = null;

export function getFfmpegPath() {
  if (ffmpegPath) return ffmpegPath;
  ffmpegPath = FFMPEG_CANDIDATES.find((p) => existsSync(p)) || 'ffmpeg';
  return ffmpegPath;
}

/**
 * The address the TV should use to reach us. Not localhost: the TV fetches.
 *
 * The first adapter the OS lists is often not the house network. With
 * Tailscale up it is a 100.x overlay address the TV has never heard of, and the
 * TV accepts the cast and then silently refuses to fetch it. So the adapter on
 * the TV's own subnet wins, and failing that the same ranking the phone QR code
 * uses.
 */
export function getLanAddress(tvHost = null) {
  if (tvHost && /^\d+\.\d+\.\d+\.\d+$/.test(tvHost)) {
    const prefix = tvHost.split('.').slice(0, 3).join('.') + '.';
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal && net.address.startsWith(prefix)) return net.address;
      }
    }
  }
  return getLanIp() || '127.0.0.1';
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Whatever a device on the network sends back is read with limits. Anything
// can answer as a TV, and an answer of any size used to be read whole and
// then searched with patterns whose cost grew with the square of its length:
// one large answer froze the app for everyone.
const MAX_ANSWERS = 32;
const MAX_ANSWERS_PER_ADDRESS = 8;
const MAX_REPLY_BYTES = 64 * 1024;

/**
 * The text of an answer, or null when it is longer than the limit. Reading
 * stops at the limit: the rest is never fetched into memory.
 */
async function readCapped(res, limit = MAX_REPLY_BYTES) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > limit) {
      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The text between <tag> and </tag>, or null. Found by plain search, which
 * takes one pass over the text however it is built.
 */
function tagText(xml, tag) {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0) return null;
  const end = xml.indexOf(`</${tag}>`, start + open.length);
  return end < 0 ? null : xml.slice(start + open.length, end);
}

/** A value that must be used whole or not at all (an id, an address). */
function atMost(text, max) {
  return text && text.length <= max ? text : null;
}

/**
 * What a device description says about the device, or null when it has no
 * usable AVTransport service. Exported for the tests.
 */
export function readDescription(xml) {
  // The service list is cut at each </service> and the first piece that
  // names AVTransport is the one wanted. The text after the last </service>
  // is not a complete service, so it is left out.
  let avBlock = null;
  const pieces = xml.split('</service>');
  for (const piece of pieces.slice(0, -1)) {
    const at = piece.indexOf('AVTransport:1');
    const start = at < 0 ? -1 : piece.lastIndexOf('<service>', at);
    if (start >= 0) {
      avBlock = piece.slice(start);
      break;
    }
  }
  const controlPath = avBlock ? atMost(tagText(avBlock, 'controlURL'), 2000) : null;
  if (!controlPath) return null;
  return {
    name: (tagText(xml, 'friendlyName') || '').trim().slice(0, 120) || 'TV',
    model: (tagText(xml, 'modelName') || '').trim().slice(0, 120) || null,
    udn: atMost(tagText(xml, 'UDN'), 200),
    controlPath,
  };
}

async function soap(controlUrl, action, bodyInner) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${AV_SERVICE}">
      <InstanceID>0</InstanceID>
      ${bodyInner}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${AV_SERVICE}#${action}"`,
    },
    body: envelope,
    // A command goes to the TV that was checked and nowhere else. Following a
    // redirect would let that device send it on to any address it liked,
    // this app's own included.
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });

  const text = (await readCapped(res)) || '';
  if (!res.ok) {
    const code = atMost(tagText(text, 'errorCode'), 6);
    const desc = (tagText(text, 'errorDescription') || '').replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`TV rejected ${action}${code && /^\d+$/.test(code) ? ` (${code} ${desc})` : ''}`);
  }
  return text;
}

// Samsung will accept a bare URI and then refuse to start without a plausible
// DIDL-Lite block, so we always send one. It is XML inside an XML attribute,
// hence the double escaping.
//
// DLNA.ORG_OP=10 means "time seek yes, byte seek no". That is the honest
// description of a live transcode: we cannot jump to byte 900,000,000 of a file
// that does not exist yet, but we can restart the encoder at minute 12.
// Claiming byte-seek instead is what makes a Samsung reconnect with a Range
// request, receive the stream from the top again, and give up after a minute.
function formatDuration(ms) {
  if (!ms || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000`;
}

function didlFor(title, url, mime, durationMs) {
  const duration = formatDuration(durationMs);
  // The conversion indicator has to agree with what the stream endpoint says
  // about itself in its own headers. A relayed stream is transformed, so CI=1;
  // an original file is untouched, so CI=0. A TV told one thing here and
  // another in the HTTP response treats the disagreement as a reason to stop.
  const converted = mime === 'video/mpeg' ? 1 : 0;
  const protocolInfo = `http-get:*:${mime}:DLNA.ORG_OP=10;DLNA.ORG_CI=${converted};DLNA.ORG_FLAGS=01700000000000000000000000000000`;
  const resAttrs = `protocolInfo="${protocolInfo}"${duration ? ` duration="${duration}"` : ''}`;
  const inner = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>${escapeXml(title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><res ${resAttrs}>${escapeXml(url)}</res></item></DIDL-Lite>`;
  return escapeXml(inner);
}

/**
 * A discovery answer is only believed when it points at the device that sent
 * it: a plain http(s) address, a private home-network IP, and the same IP the
 * answer arrived from. Anything on the network can answer a discovery call,
 * and an answer naming some other machine used to be fetched without question.
 */
export function describesItself(location, responderAddress) {
  let url;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isHomeNetworkAddress(url.hostname) && url.hostname === responderAddress;
}

/**
 * Where a TV takes its commands, or null when its description points them at
 * a different machine. Control addresses are normally written relative to the
 * description ("/upnp/control/AVTransport1"), but a full address is also
 * legal, and a fake TV could use one to have this app send its commands to
 * any host on the network. Commands only ever go to the TV that answered.
 */
export function controlUrlFor(location, controlPath) {
  try {
    const base = new URL(location);
    const control = new URL(controlPath, `${base.protocol}//${base.host}`);
    if (control.protocol !== 'http:' && control.protocol !== 'https:') return null;
    if (control.hostname !== base.hostname) return null;
    return control.toString();
  } catch {
    return null;
  }
}

/**
 * Find MediaRenderers on the LAN by SSDP. Falls back to whatever we found last
 * time, because TVs stop answering discovery the moment they sleep.
 */
let lastDiscovered = [];

// One search at a time. Every device that opened the TV list, and every
// request naming a TV not seen yet, used to start a search of its own.
let discoveryInFlight = null;

export function discoverRenderers(timeoutMs = 3000) {
  if (!discoveryInFlight) {
    discoveryInFlight = searchForRenderers(timeoutMs).finally(() => {
      discoveryInFlight = null;
    });
  }
  return discoveryInFlight;
}

async function searchForRenderers(timeoutMs) {
  const found = new Map();
  const perAddress = new Map();

  await new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const message = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n'
    );

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const location = (text.match(/LOCATION:\s*(\S+)/i) || [])[1];
      // Only a device describing itself: the address in its answer must be the
      // address the answer came from, on the home network.
      if (!location || location.length > 2000 || found.has(location)) return;
      if (!describesItself(location, rinfo?.address)) return;
      // And only so many: one device may not fill the list, or crowd the
      // real TVs out of it, by answering hundreds of times.
      const fromHere = perAddress.get(rinfo.address) || 0;
      if (found.size >= MAX_ANSWERS || fromHere >= MAX_ANSWERS_PER_ADDRESS) return;
      perAddress.set(rinfo.address, fromHere + 1);
      found.set(location, { location });
    });

    socket.on('error', () => {});

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(message, 0, message.length, 1900, '239.255.255.250');
      } catch { /* discovery is best-effort */ }
    });

    setTimeout(() => {
      try { socket.close(); } catch { /* already closed */ }
      resolve();
    }, timeoutMs);
  });

  const devices = [];
  for (const { location } of found.values()) {
    try {
      // No redirects: the description is read from the device that answered,
      // not from wherever that device points.
      const res = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const xml = await readCapped(res);
      const described = xml ? readDescription(xml) : null;
      if (!described) continue;

      // Control URLs in the description are relative to the description's host.
      const controlUrl = controlUrlFor(location, described.controlPath);
      if (!controlUrl) continue;

      devices.push({
        id: described.udn || controlUrl,
        name: described.name,
        model: described.model,
        controlUrl,
        // The address it answered from, which is also where its commands go.
        host: new URL(controlUrl).hostname,
      });
    } catch { /* a renderer that will not describe itself is not usable */ }
  }

  if (devices.length > 0) lastDiscovered = devices;
  return devices.length > 0 ? devices : lastDiscovered;
}

/**
 * Is this a TV we found ourselves?
 *
 * Every TV command is a POST to a control address, and that address used to be
 * taken from whoever sent the request. Anything on the network could then make
 * this app post to any machine it liked, and a direct play would hand that
 * machine a Plex file address with a friend's share token in it. Only addresses
 * that discovery actually turned up are accepted now; an unknown one gets one
 * fresh discovery pass in case the TV has only just woken.
 */
export async function isKnownRenderer(controlUrl) {
  return Boolean(await findRenderer(controlUrl));
}

/** The TV that discovery found at this control address, or null. */
export async function findRenderer(controlUrl) {
  const known = () => lastDiscovered.find((d) => d.controlUrl === controlUrl) || null;
  if (typeof controlUrl !== 'string' || !controlUrl) return null;
  if (known()) return known();
  await discoverRenderers();
  return known();
}

/** The TVs found on the network that give themselves this id. Normally one. */
export async function renderersWithId(id) {
  const matching = () => lastDiscovered.filter((d) => d.id === id);
  if (matching().length > 0) return matching();
  await discoverRenderers();
  return matching();
}

// ---------- TVs the owner has approved ----------
//
// Discovery only shows that a device answered as a TV from its own address;
// any program on the network can do that. That is fine for the owner, who
// picks the TV in front of them. It is not fine for a device that merely
// entered the PIN: it could run such a program, cast any film to it, and keep
// the file, which is a download by another name (and downloads are the
// owner's to allow). So the owner approves TVs, and other devices may only
// use approved ones.
//
// An approval is for the id the TV gives itself at the address it answered
// from. The id alone would not do: it is public, and a program could copy
// it. What this cannot stop is a device that takes over an approved TV's
// address, because DLNA gives a TV no way to prove which device it is.

const MAX_APPROVED_TVS = 50;

export function isApprovedTv(device) {
  return approvedTvs().some((tv) => tv.id === device.id && tv.host === device.host);
}

// Told when a TV stops being approved: the owner removed it, it answered from
// a new address and its entry was replaced, or it fell off a full list. The
// links already handed to that TV are held in routes/tv.js, which registers
// here to withdraw them. (This file cannot import that one: it imports this.)
// Before this, Remove stopped new casts and nothing else, so a removed device
// could go on fetching the films it had been sent for up to twelve hours.
const removalListeners = [];

export function onApprovedTvRemoved(listener) {
  removalListeners.push(listener);
}

function saveApprovedTvs(next) {
  const before = approvedTvs();
  try {
    updateConfig({ approvedTvs: next });
  } finally {
    // Judged by the list the app now works from, even when it could not be
    // written to disk: a TV this process no longer accepts keeps no link.
    const after = approvedTvs();
    for (const tv of before) {
      if (after.some((kept) => kept.id === tv.id && kept.host === tv.host)) continue;
      for (const listener of removalListeners) {
        try {
          listener(tv);
        } catch (err) {
          console.error('Could not withdraw the links of a removed TV:', err.message);
        }
      }
    }
  }
}

/** Approves a TV that discovery found. One entry per id: a TV whose address changed replaces its old entry. */
export function approveTv(device) {
  if (isApprovedTv(device)) return;
  const others = approvedTvs().filter((tv) => tv.id !== device.id);
  saveApprovedTvs([...others, { id: device.id, name: device.name, host: device.host }].slice(-MAX_APPROVED_TVS));
}

export function removeApprovedTv(id) {
  saveApprovedTvs(approvedTvs().filter((tv) => tv.id !== id));
}

// The token goes as a header, and through plexFetch, so an answer that
// redirects to another machine is refused instead of followed.
async function plexJson(serverUri, path, token) {
  const res = await plexFetch(`${serverUri}${path}`, {
    headers: { Accept: 'application/json', 'X-Plex-Token': token },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Plex metadata failed: ${res.status}`);
  return res.json();
}

/**
 * Turn whatever was tapped into something that actually has a file behind it.
 *
 * A series is a label, not a video: only its episodes have files. Sending a
 * series to the TV therefore asked Plex for a file that does not exist and got
 * back "no playable file" — and since half the titles on the front page are
 * series, half the posters in the app could not be played.
 *
 * Picking the first unwatched episode is the answer to the question actually
 * being asked. Someone tapping a series they are partway through means "carry
 * on", and someone tapping a new one means "start it"; the first episode
 * nobody has watched is both of those.
 */
async function resolvePlayable(serverUri, item, token) {
  const hasFile = (candidate) => Boolean(candidate?.Media?.[0]?.Part?.[0]?.key);
  if (hasFile(item)) return item;
  if (item.type !== 'show' && item.type !== 'season') return item;

  // allLeaves is every episode of a series, flat and in order, in one request —
  // rather than walking seasons and then episodes a request at a time.
  const data = await plexJson(serverUri, `/library/metadata/${plexId(item.ratingKey)}/allLeaves`, token);
  const episodes = (data.MediaContainer?.Metadata || []).filter(hasFile);
  if (episodes.length === 0) return item;

  const nextUp = episodes.find((ep) => !(ep.viewCount > 0)) || episodes[0];
  return {
    ...nextUp,
    // Named so the TV and the app show "Sherlock · S1E1 A Study in Pink"
    // rather than an episode title with no series attached to it.
    title: [
      nextUp.grandparentTitle || item.title,
      // Specials and odd episodes carry no numbers, and "SundefinedEundefined"
      // is worse than leaving the label out.
      Number.isFinite(nextUp.parentIndex) && Number.isFinite(nextUp.index) ? `S${nextUp.parentIndex}E${nextUp.index}` : null,
      nextUp.title,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * Metadata we need to decide direct-play vs relay, or null when the title is
 * not in a library the app lists.
 *
 * `server` is the entry of the server list, not only its address. The title
 * number comes from a request and could name anything on that server (a
 * photo, a music track), and the server's token would fetch it. So Plex's
 * answer is checked against the listed libraries here, inside the one
 * function every cast and relay goes through, where no caller can skip it.
 * The check comes straight after the one read of the title: nothing else is
 * asked first, so a series outside those libraries is never asked for its
 * episodes. A caller that gets null answers 404 and sends the TV nothing.
 */
export async function getPlaybackInfo(server, ratingKey, token) {
  const serverUri = server.uri;
  const data = await plexJson(serverUri, `/library/metadata/${plexId(ratingKey)}`, token);
  if (!(await isListedItem(server, data, token))) return null;
  const requested = data.MediaContainer?.Metadata?.[0];
  if (!requested) throw new Error('Title not found on that server');

  const item = await resolvePlayable(serverUri, requested, token);

  const media = item.Media?.[0];
  const part = media?.Part?.[0];
  if (!part?.key) throw new Error('No playable file for that title');

  return {
    // The key of the thing actually being played, which for a series is an
    // episode rather than the series that was tapped. Anything downstream that
    // fetches the file again — the relay especially — has to use this one.
    // It comes from the server's answer and goes into addresses on this app,
    // so it is checked to be a plain number first.
    ratingKey: plexId(item.ratingKey),
    title: item.title || 'Untitled',
    year: item.year || null,
    duration: item.duration || null,
    container: (media.container || '').toLowerCase(),
    videoCodec: (media.videoCodec || '').toLowerCase(),
    audioCodec: (media.audioCodec || '').toLowerCase(),
    // Where the file is, with no token in the address. The part of it after
    // the server comes from that server's own answer, and the server may be
    // someone else's: an answer that names another machine is refused here
    // (sameOriginUrl throws), so the token can never be sent to one.
    //
    // No token is returned at all. ffmpeg is never given one, in the address
    // or as a -headers argument: both are part of its command line, which
    // `ps` shows to every account on the machine. It reads the file through
    // /api/tv/file, and that route adds the token inside this process.
    fileUrlBare: sameOriginUrl(serverUri, part.key),
  };
}

/**
 * Can the TV eat this file as-is? When yes we hand over the Plex URL directly,
 * which costs us nothing and gives full quality. When no, we relay.
 *
 * Two separate reasons to relay, and only the first was being checked.
 *
 * The codecs have to be ones the TV can decode — that was here already. But the
 * TV also has to be able to *fetch* the file, and every server in this setup is
 * someone else's machine reached over https on the public internet. Handing a
 * television an https address and asking it to do certificate validation on a
 * multi-gigabyte video is asking for the error it gives you. A DLNA renderer
 * expects plain http from something nearby, so anything else goes through this
 * Mac, which can talk https perfectly well.
 */
export function videoNeedsConverting(info) {
  return !SAFE_VIDEO_CODECS.has(info.videoCodec);
}

export function needsRelay(info) {
  if (!info.fileUrlBare.startsWith('http://')) return true;
  if (!SAFE_CONTAINERS.has(info.container)) return true;
  if (!SAFE_VIDEO_CODECS.has(info.videoCodec)) return true;
  if (!SAFE_AUDIO_CODECS.has(info.audioCodec)) return true;
  return false;
}

export async function play(controlUrl, url, title, mime = 'video/mp4', durationMs = null) {
  await soap(
    controlUrl,
    'SetAVTransportURI',
    `<CurrentURI>${escapeXml(url)}</CurrentURI><CurrentURIMetaData>${didlFor(title, url, mime, durationMs)}</CurrentURIMetaData>`
  );
  await soap(controlUrl, 'Play', '<Speed>1</Speed>');
}

export async function stop(controlUrl) {
  await soap(controlUrl, 'Stop', '');
}

export async function pause(controlUrl) {
  await soap(controlUrl, 'Pause', '');
}

export async function resume(controlUrl) {
  await soap(controlUrl, 'Play', '<Speed>1</Speed>');
}

export async function transportState(controlUrl) {
  const xml = await soap(controlUrl, 'GetTransportInfo', '');
  const state = tagText(xml, 'CurrentTransportState') || '';
  return /^[A-Z_]{1,40}$/.test(state) ? state : 'UNKNOWN';
}
