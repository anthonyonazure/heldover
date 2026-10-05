import crypto from 'crypto';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import net from 'net';
import { discoverRenderers, getPlaybackInfo, videoNeedsConverting, getFfmpegPath, findRenderer, isApprovedTv, approveTv, onApprovedTvRemoved, needsRelay, getLanAddress, play as tvPlay, stop as tvStop, pause as tvPause, resume as tvResume, transportState } from '../tv.js';
import { PORT, app, ensureServers, getPlexToken } from '../app.js';
import { bindHost } from '../listen-address.js';
import { plexFetch } from '../plex-fetch.js';
import { isLocal, isOwner } from '../auth.js';

/**
 * GET /api/tv/devices
 * TVs and other UPnP renderers on the LAN we can cast to.
 */
app.get('/api/tv/devices', async (req, res) => {
  try {
    const devices = await discoverRenderers();
    res.json({ devices, count: devices.length });
  } catch (err) {
    console.error('Error discovering renderers:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tv/stream/:serverKey/:ratingKey
 * The relay. Pulls the file from Plex, keeps the video stream untouched, and
 * re-encodes only the audio into something a TV will actually decode. This is
 * what makes DTS-MA and TrueHD titles playable on a Samsung.
 */
/**
 * HEAD /api/tv/stream/:serverKey/:ratingKey
 * Samsung probes the URL with a HEAD before it will accept it, and Express
 * would otherwise route HEAD into the streaming handler below, which never
 * ends for a HEAD — the TV times out and reports "resource not found".
 */
// CI=1 says honestly that this is transformed rather than the original file.
// No DLNA.ORG_PN: the profile names for h264-in-TS are a matrix of resolution
// and audio codec, and naming the wrong one is worse than naming none — most
// renderers accept a stream with no profile and reject one that lies.
const DLNA_CONTENT_FEATURES =
  'DLNA.ORG_OP=10;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000';

// What the relay produces.
//
// It used to be fragmented MP4. That container needs an index the player is
// expected to have, and a live stream has no index to give it — which produces
// exactly the reported failure: the TV accepts the stream, starts, stalls, and
// sits on a dead screen. MPEG-TS was designed for broadcast: it carries no
// index, every packet stands alone, and a player can begin from anywhere.
// Measured on this library it also starts in a third of the time, 1.1s against
// 3.9s, which matters because a television gives up on a slow start.
const RELAY_MIME = 'video/mpeg';

app.head('/api/tv/stream/:serverKey/:ratingKey', (req, res) => {
  // A TV asks HEAD before it commits, and compares the answer with what it was
  // told in the play command. Saying one type here and another there is on its
  // own enough for it to refuse the stream.
  res.setHeader('Content-Type', RELAY_MIME);
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('transferMode.dlna.org', 'Streaming');
  res.setHeader('contentFeatures.dlna.org', DLNA_CONTENT_FEATURES);
  res.status(200).end();
});

/** `npt=93.4-` or `npt=0:01:33.4-0:02:00` → seconds. */
function parseNptSeconds(header) {
  if (!header) return 0;
  const value = String(header).replace(/^npt\s*=\s*/i, '').split('-')[0].trim();
  if (!value) return 0;
  if (value.includes(':')) {
    const parts = value.split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((acc, part) => acc * 60 + part, 0);
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

// Relay tickets. The stream address used to be open to anyone who could reach
// this app, which made it a way for any device on the network to pull any
// title from a friend's server through here, one ffmpeg per request. Now only
// an address this app handed to a TV works: /api/tv/play issues a ticket for
// that one title, and it lasts long enough for a film plus the TV's reconnects.
//
// A ticket is also for one device: `host` is the address of the TV it was
// made for, and the ticketed routes refuse it from anywhere else. The address
// goes to the TV in a plain command that the TV may repeat to anything that
// asks, so on its own the ticket was a key any device could pick up and use.
//
// And it is for that TV as the owner accepted it: `tvId` is the id the TV
// gives itself (null for the ticket the app's own ffmpeg reads with). A
// ticket used to outlive the reason it was made, for the whole twelve hours.
// Now it is withdrawn when the owner removes the TV, when the TV refuses the
// cast, and on Stop (see withdrawLinks below).
const RELAY_TICKET_TTL_MS = 12 * 60 * 60 * 1000;
const relayTickets = new Map();

function issueRelayTicket(serverKey, ratingKey, host, fileUrlBare = null, tvId = null) {
  const now = Date.now();
  for (const [ticket, entry] of relayTickets) {
    if (entry.expires < now) relayTickets.delete(ticket);
  }
  const ticket = crypto.randomBytes(16).toString('hex');
  relayTickets.set(ticket, {
    serverKey,
    ratingKey: String(ratingKey),
    host: plainAddress(host),
    fileUrlBare,
    tvId,
    expires: now + RELAY_TICKET_TTL_MS,
  });
  return ticket;
}

/** How many tickets are outstanding. For the tests. */
export function ticketsOutstanding() {
  return relayTickets.size;
}

/** An address as plain text to compare: no IPv4-in-IPv6 prefix, one spelling of an IPv6 address. */
function plainAddress(address) {
  const text = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (text.startsWith('::ffff:') && net.isIPv4(text.slice(7))) return text.slice(7);
  if (!net.isIPv6(text)) return text;
  try {
    return new URL(`http://[${text}]`).hostname.slice(1, -1);
  } catch {
    return text;
  }
}

/**
 * May this caller use this ticket? Only the device it was made for, judged by
 * the address the connection really comes from (never by a header), and this
 * computer itself: the app's own ffmpeg reads through here, and whoever sits
 * at this computer is the owner anyway.
 */
export function ticketOpenTo(entry, req) {
  if (isLocal(req)) return true;
  return Boolean(entry.host) && plainAddress(req.socket?.remoteAddress) === entry.host;
}

// What is being sent on a link right now: each answer of the two ticketed
// routes, until its connection closes. Taking a ticket off the list refuses
// the next request, but the file route reads its ticket once and then passes
// bytes until the TV hangs up, and a relay runs until its film ends, so a
// transfer that had started would carry on to the end of the film.
const linkUses = new Set();

function linkInUse(entry, res) {
  const use = { entry, res };
  linkUses.add(use);
  res.on('close', () => linkUses.delete(use));
}

/**
 * Takes back every ticket that `matches`, and ends what is being sent on it:
 * closing the answer stops a file transfer (its request to the Plex server is
 * abandoned) and stops a relay (its ffmpeg is killed, and the ticket ffmpeg
 * read with goes too). Returns how many tickets were taken back. Nothing here
 * asks the network anything, and the ticketed routes need no check of the
 * approved list on each request: a ticket that is gone answers 403.
 */
function withdrawLinks(matches) {
  const gone = new Set();
  for (const [ticket, entry] of relayTickets) {
    if (!matches(entry, ticket)) continue;
    relayTickets.delete(ticket);
    gone.add(entry);
  }
  for (const use of [...linkUses]) {
    if (gone.has(use.entry)) use.res.destroy();
  }
  return gone.size;
}

/** The links made for one TV: the id it gives itself, at the address it answered from. */
function withdrawLinksOfTv(tv) {
  if (!tv?.id) return 0;
  const address = plainAddress(tv.host);
  return withdrawLinks((entry) => entry.tvId === tv.id && entry.host === address);
}

// A TV the owner removed gets nothing more, as a TV that was never approved.
onApprovedTvRemoved((tv) => {
  const withdrawn = withdrawLinksOfTv(tv);
  if (withdrawn > 0) {
    console.log(`[tv] the TV at ${plainAddress(tv.host)} is no longer approved: ${withdrawn} link${withdrawn === 1 ? '' : 's'} made for it withdrawn`);
  }
});

/**
 * GET/HEAD /api/tv/file/:serverKey/:ratingKey?t=<ticket>
 * The original file for a TV that can play it as it is. The TV used to be
 * handed the Plex address itself, with a friend's share token in it, so any
 * device on the network that answered as a "TV" could collect the token. Now
 * the TV gets this ticketed address and the token stays here. Range requests
 * pass straight through, so seeking works as it did.
 */
app.get('/api/tv/file/:serverKey/:ratingKey', async (req, res) => {
  try {
    const { serverKey, ratingKey } = req.params;
    const entry = typeof req.query.t === 'string' ? relayTickets.get(req.query.t) : null;
    if (
      !entry || entry.expires < Date.now() || !entry.fileUrlBare ||
      entry.serverKey !== serverKey || entry.ratingKey !== String(ratingKey) ||
      !ticketOpenTo(entry, req)
    ) {
      return res.status(403).end();
    }
    const servers = await ensureServers();
    const server = servers.find((s) => s.clientIdentifier === serverKey);
    if (!server) return res.status(404).end();
    // The wait above is long enough for the ticket to be withdrawn.
    if (relayTickets.get(req.query.t) !== entry) return res.status(403).end();

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    linkInUse(entry, res);
    // plexFetch, so a server that answers with a redirect to another machine
    // is refused: the token below only ever goes to the server it belongs to.
    const upstream = await plexFetch(entry.fileUrlBare, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: {
        'X-Plex-Token': server.accessToken || getPlexToken(),
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      signal: controller.signal,
    });
    res.status(upstream.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    if (err.name !== 'AbortError') console.error('Error passing a file to the TV:', redactToken(err.message));
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  }
});

// A ticket for the file route does not start a relay: the one ffmpeg holds
// (see ffmpegInput below) is for reading its input and nothing else.
// Answers with the ticket's entry, or null.
function relayTicketValid(req, serverKey, ratingKey) {
  const entry = typeof req.query.t === 'string' ? relayTickets.get(req.query.t) : null;
  const valid =
    entry && !entry.fileUrlBare && entry.expires > Date.now() &&
    entry.serverKey === serverKey && entry.ratingKey === String(ratingKey) &&
    ticketOpenTo(entry, req);
  return valid ? entry : null;
}

// One TV plays one thing at a time. A reconnecting TV opens a new relay before
// the old socket is noticed as dead, so a small cap that retires the oldest
// keeps that working while stopping relays from piling up without limit.
const MAX_RELAYS = 2;
const activeRelays = [];

// Keeps secrets out of log lines and error answers: a Plex token, and the
// ticket in one of this app's own TV addresses (ffmpeg names its input
// address when it complains about it).
function redactToken(text) {
  return String(text)
    .replace(/X-Plex-Token[=:]\s*[^&\s"']+/gi, 'X-Plex-Token=***')
    .replace(/([?&]t=)[0-9a-f]{32}/gi, '$1***');
}

/**
 * The address this server itself answers on, for ffmpeg to read its input
 * from. BIND_HOST may name one address only, and then 127.0.0.1 does not
 * answer, so this follows the address the server listens on.
 */
export function ownHost() {
  const host = bindHost();
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

export function ownOrigin(port) {
  const host = ownHost();
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

// What ffmpeg is started with: this process's environment, minus the Plex
// token, the API keys and anything else named like a secret. ffmpeg needs none
// of them, and a child process should not carry what it has no use for.
// A proxy setting goes too: ffmpeg would send the request for its input, with
// the ticket in it, to the proxy, and its input is this computer itself.
function ffmpegEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|KEY/i.test(name) || /_proxy$/i.test(name)) delete env[name];
  }
  return env;
}

// What ffmpeg may read, and as what. Its one input is this app's own ticketed
// address, but the bytes that arrive there are whatever the Plex server
// sends, and that server may be someone else's. Left to work the format out
// from those bytes, ffmpeg takes a short text playlist in place of a film and
// then fetches the addresses the playlist names, on this computer or on the
// home network. So the format is fixed from the container Plex reports: read
// as a film file, a playlist is only bad data.
//
// Left: the container as Plex names it. Right: ffmpeg's name for the format
// that reads it. They differ, and a wrong name fails every cast of that kind
// of file: ffmpeg has no "mkv", "ts" or "wmv", and its "m4v" is raw MPEG-4
// video, not the .m4v file ("mov" reads mp4, m4v and mov alike). Each name on
// the right is in `ffmpeg -demuxers` of both ffmpeg 5.1 (the Docker image)
// and 9.0.
const INPUT_FORMATS = new Map([
  ['mkv', 'matroska'],
  ['webm', 'matroska'],
  ['mp4', 'mov'],
  ['m4v', 'mov'],
  ['mov', 'mov'],
  ['avi', 'avi'],
  ['ts', 'mpegts'],
  ['m2ts', 'mpegts'],
  ['mpegts', 'mpegts'],
  ['wmv', 'asf'],
  ['asf', 'asf'],
  ['flv', 'flv'],
  ['mpeg', 'mpeg'],
  ['ogm', 'ogg'],
]);

// For a container that is missing (Plex has not analyzed the file yet) or
// not in the list above. Such a title is still relayed, as it was: ffmpeg
// works the format out from the bytes, but may only settle on one of the
// ordinary film formats above. A playlist, or any other format that reads
// further addresses, is refused before anything it names is opened.
const INPUT_FORMATS_ALLOWED = [...new Set(INPUT_FORMATS.values())].join(',');

// Reading one http address needs these two and no others: no local file, no
// https, no data: or concat: address, whatever the input turns out to hold.
const INPUT_PROTOCOLS = 'http,tcp';

/** The ffmpeg options, placed before -i, that keep the converter to its one input. */
export function converterInputLimits(container) {
  const format = INPUT_FORMATS.get(String(container || '').toLowerCase());
  return [
    '-protocol_whitelist', INPUT_PROTOCOLS,
    ...(format ? ['-f', format] : ['-format_whitelist', INPUT_FORMATS_ALLOWED]),
  ];
}

app.get('/api/tv/stream/:serverKey/:ratingKey', async (req, res) => {
  let ffmpeg = null;
  let inputTicket = null;
  try {
    const token = getPlexToken();
    const { serverKey, ratingKey } = req.params;
    const entry = relayTicketValid(req, serverKey, ratingKey);
    if (!entry) return res.status(403).end();

    const servers = await ensureServers();
    const server = servers.find((s) => s.clientIdentifier === serverKey);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const info = await getPlaybackInfo(server, ratingKey, server.accessToken || token);
    // Not a title from a library the app lists: no encoder is started and
    // the Plex server is asked for nothing more.
    if (!info) return res.status(404).json({ error: 'Item not found' });

    // The lookup above can take many seconds. A TV that gave up in the
    // meantime has already closed the socket, and that close event has
    // already fired, so nothing below would ever kill the encoder it started.
    if (req.destroyed || res.writableEnded) return;
    // Or the ticket was withdrawn in the meantime (the owner removed the TV,
    // or someone pressed Stop): no encoder is started for it.
    if (relayTickets.get(req.query.t) !== entry) return res.status(403).end();

    // The TV reconnects mid-film and asks to resume at a timestamp rather than
    // a byte offset. Honour that by restarting the encoder at that point; if we
    // ignored it we would serve the opening scene again and the TV would quit.
    const startSeconds = parseNptSeconds(
      req.headers['timeseekrange.dlna.org'] || req.headers['x-seek-range']
    );
    const durationSeconds = info.duration ? info.duration / 1000 : null;

    // Set now, but only sent with the first bytes of video. If ffmpeg fails
    // before producing any, the TV gets an error rather than an empty "200 OK"
    // that it would sit on while the app claims the film is playing.
    res.setHeader('Content-Type', RELAY_MIME);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader('contentFeatures.dlna.org', DLNA_CONTENT_FEATURES);
    if (durationSeconds) {
      res.setHeader(
        'TimeSeekRange.dlna.org',
        `npt=${startSeconds.toFixed(3)}-${durationSeconds.toFixed(3)}/${durationSeconds.toFixed(3)}`
      );
    }

    // Video the TV can decode is copied untouched, which is nearly free. Video
    // it cannot decode was being copied too, so relaying it changed nothing
    // and the TV still refused it; that is now re-encoded.
    // A hardware encoder is used on macOS; elsewhere libx264 at its
    // fastest preset keeps a live encode ahead of playback on ordinary CPUs.
    const encoder = process.platform === 'darwin'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', '8M']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21'];
    const videoArgs = videoNeedsConverting(info)
      ? [...encoder, '-pix_fmt', 'yuv420p']
      : ['-c:v', 'copy'];

    // ffmpeg reads the file through this app's own ticketed route
    // (/api/tv/file above), which adds the Plex token inside this process and
    // keeps the request on the Plex server. A program's arguments can be read
    // by every account on the computer, so no Plex token is among them, as an
    // address or as a header. What is there is a ticket for this one title
    // that only this app accepts, only from this computer (ffmpeg connects
    // from the same address it connects to), and only until this relay ends.
    inputTicket = issueRelayTicket(serverKey, info.ratingKey, ownHost(), info.fileUrlBare);
    const ffmpegInput =
      `${ownOrigin(req.socket.localPort || PORT)}/api/tv/file/` +
      `${encodeURIComponent(serverKey)}/${info.ratingKey}?t=${inputTicket}`;

    ffmpeg = spawn(getFfmpegPath(), [
      '-hide_banner',
      '-loglevel', 'error',
      // Keep startup latency low: the TV gives up if first bytes are slow.
      // Small enough to start quickly, large enough to identify the streams.
      '-probesize', '1M',
      '-analyzeduration', '1M',
      ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
      // A fixed input format and a protocol list: see converterInputLimits.
      ...converterInputLimits(info.container),
      '-i', ffmpegInput,
      '-map', '0:v:0',
      '-map', '0:a:0',
      ...videoArgs,
      '-c:a', 'aac',
      '-ac', '2',
      '-b:a', '192k',
      '-f', 'mpegts',
      'pipe:1',
    ], { env: ffmpegEnv() });

    // The TV closing the socket must kill the encode, or every abandoned cast
    // leaves an ffmpeg chewing a core. The ticket ffmpeg read with goes too.
    const relay = ffmpeg;
    const ticket = inputTicket;
    const kill = () => {
      relayTickets.delete(ticket);
      if (!relay.killed) relay.kill('SIGKILL');
      const at = activeRelays.indexOf(relay);
      if (at >= 0) activeRelays.splice(at, 1);
    };
    activeRelays.push(relay);
    while (activeRelays.length > MAX_RELAYS) {
      const oldest = activeRelays.shift();
      if (!oldest.killed) oldest.kill('SIGKILL');
    }
    res.on('close', kill);
    res.on('error', kill);
    // Withdrawing the link this relay was started with closes this answer,
    // and the close stops the encoder (kill, above).
    linkInUse(entry, res);

    ffmpeg.stdout.pipe(res, { end: false });
    ffmpeg.stderr.on('data', (d) => {
      const line = redactToken(d.toString().trim());
      if (line) console.error('[tv relay]', line.slice(0, 200));
    });
    ffmpeg.on('close', (code) => {
      kill();
      if (code && !res.headersSent) res.status(502).end();
      else res.end();
    });
    ffmpeg.on('error', (err) => {
      console.error('Relay failed to start ffmpeg:', err.message);
      kill();
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error('Error relaying stream:', redactToken(err.message));
    if (inputTicket) relayTickets.delete(inputTicket);
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGKILL');
    if (!res.headersSent) res.status(500).json({ error: redactToken(err.message) });
  }
});

/**
 * POST /api/tv/play
 * Body: { serverKey, ratingKey, controlUrl }
 * Sends a title to the TV, relaying through ffmpeg only when the file would
 * not play natively.
 */
// A Plex server or plex.tv that is busy for a moment (a big library being
// read, a restart) answers a second attempt fine. One retry, only for timeouts.
async function retryOnTimeout(work) {
  try {
    return await work();
  } catch (err) {
    if (err.name !== 'TimeoutError' && !/timeout|timed out/i.test(err.message)) throw err;
    return work();
  }
}

const TV_NOT_APPROVED =
  'The owner needs to approve this TV first. On the computer that runs Heldover, open Settings, TVs.';

/**
 * The TV a request names, if this caller may use it; otherwise the request is
 * answered here and null comes back. The owner may use any TV that discovery
 * found. Every other device may only use a TV the owner has approved, so a
 * device that entered the PIN cannot name its own program as "the TV" and
 * have a film sent to it.
 */
async function rendererFor(req, res, controlUrl, notFound) {
  const device = await findRenderer(controlUrl);
  if (!device) {
    res.status(400).json({ error: notFound });
    return null;
  }
  if (!isOwner(req) && !isApprovedTv(device)) {
    res.status(403).json({ error: TV_NOT_APPROVED, tvNotApproved: true });
    return null;
  }
  return device;
}

app.post('/api/tv/play', async (req, res) => {
  // Which step is running, so a failure says what failed. "The operation was
  // aborted due to timeout" on its own could have been plex.tv, the film's
  // server, or the TV, and each needs a different fix.
  let step = 'finding the TV';
  try {
    const token = getPlexToken();
    const { serverKey, ratingKey, controlUrl } = req.body || {};
    if (!serverKey || !ratingKey || !controlUrl) {
      return res.status(400).json({ error: 'serverKey, ratingKey and controlUrl are required' });
    }
    // Before anything else: a refused device gets no ticket, the Plex server
    // is not asked anything, and no command goes to the TV.
    const device = await rendererFor(req, res, controlUrl, 'That TV was not found on the network. Refresh the TV list and try again.');
    if (!device) return;

    step = 'getting your Plex server list from plex.tv';
    const servers = await retryOnTimeout(() => ensureServers());
    const server = servers.find((s) => s.clientIdentifier === serverKey);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    step = `asking ${server.name} about this title`;
    const info = await retryOnTimeout(() => getPlaybackInfo(server, ratingKey, server.accessToken || token));
    // Not a title from a library the app lists (a photo, a music track): no
    // ticket is made and no command goes to the TV.
    if (!info) return res.status(404).json({ error: 'Item not found' });
    const relayed = needsRelay(info);

    // info.ratingKey, not the one that was tapped: a series resolves to an
    // episode, and the relay has to fetch that episode rather than the series,
    // which has no file at all.
    // The ticket is for this TV's address and no other. The address with the
    // ticket in it goes to the TV only: never into the answer to whoever
    // asked for the cast, and never into the log.
    const tvHost = device.host;
    // The owner may have removed the TV while the Plex server was being
    // asked. Its links were withdrawn then, and this one must not be made
    // after the fact. Read from the saved list: nothing is asked of the network.
    if (!isOwner(req) && !isApprovedTv(device)) {
      return res.status(403).json({ error: TV_NOT_APPROVED, tvNotApproved: true });
    }
    const base = `http://${getLanAddress(tvHost)}:${PORT}`;
    const ticket = issueRelayTicket(serverKey, info.ratingKey, tvHost, relayed ? null : info.fileUrlBare, device.id);
    const url = `${base}/api/tv/${relayed ? 'stream' : 'file'}/${serverKey}/${info.ratingKey}?t=${ticket}`;

    // The relayed stream is MPEG-TS; a direct file is whatever Plex holds.
    // Telling the TV the wrong one is enough on its own to make it refuse.
    // Logged because this is the one path that fails on a television across the
    // room, where nothing can be inspected after the fact. Knowing which route
    // was taken and what the TV was handed is the difference between a
    // diagnosis and another guess.
    console.log(
      `[tv] ${info.title} -> ${relayed ? 'relay' : 'direct'} | ` +
        `${info.container}/${info.videoCodec}/${info.audioCodec} | ${url.split('?')[0]}`
    );

    step = 'sending it to the TV (is the TV on?)';
    try {
      await tvPlay(controlUrl, url, info.title, relayed ? RELAY_MIME : 'video/mp4', info.duration);
    } catch (err) {
      // A cast the app reports as failed leaves no working link behind. The
      // TV may have been told the address before it refused to play.
      withdrawLinks((entry, issued) => issued === ticket);
      throw err;
    }
    console.log(`[tv] the TV accepted it: ${info.title}`);

    // A TV the owner casts to is one the owner accepts: other devices may use
    // it from now on. The film is already playing, so a list that cannot be
    // saved is logged and not reported as a failed cast.
    if (isOwner(req)) {
      try {
        approveTv(device);
      } catch (err) {
        console.error('Could not save the approved TV:', err.message);
      }
    }

    res.json({
      ok: true,
      title: info.title,
      relayed,
      reason: relayed ? `${info.container}/${info.videoCodec}/${info.audioCodec} needs converting for the TV` : 'playing the original file',
    });
  } catch (err) {
    const why = /timeout|timed out/i.test(err.message) ? 'took too long' : redactToken(err.message);
    console.error(`Error casting to TV while ${step}: ${redactToken(err.message)}`);
    res.status(500).json({ error: `Could not start it on the TV: ${step} ${why === 'took too long' ? 'took too long. Try again.' : `failed (${why}).`}` });
  }
});

/**
 * POST /api/tv/control
 * Body: { controlUrl, action } where action is stop | pause | resume.
 */
app.post('/api/tv/control', async (req, res) => {
  try {
    const { controlUrl, action } = req.body || {};
    if (!controlUrl) return res.status(400).json({ error: 'controlUrl is required' });
    const device = await rendererFor(req, res, controlUrl, 'Unknown TV');
    if (!device) return;

    if (action === 'stop') {
      // Stop ends the film for good: the TV's links are withdrawn and a relay
      // that is running for it is stopped. Also when the TV did not answer
      // the command (switched off at the wall, say): the person asked for the
      // film to stop, and a link left behind would keep working for hours.
      // Pause keeps the links, because the TV comes back for the same one.
      try {
        await tvStop(controlUrl);
      } finally {
        withdrawLinksOfTv(device);
      }
    } else if (action === 'pause') await tvPause(controlUrl);
    else if (action === 'resume') await tvResume(controlUrl);
    else return res.status(400).json({ error: 'action must be stop, pause or resume' });

    res.json({ ok: true, action });
  } catch (err) {
    console.error('Error controlling TV:', redactToken(err.message));
    res.status(500).json({ error: redactToken(err.message) });
  }
});

/**
 * GET /api/tv/state?controlUrl=...
 */
app.get('/api/tv/state', async (req, res) => {
  try {
    const { controlUrl } = req.query;
    if (!controlUrl) return res.status(400).json({ error: 'controlUrl is required' });
    if (!(await rendererFor(req, res, controlUrl, 'Unknown TV'))) return;
    res.json({ state: await transportState(controlUrl) });
  } catch (err) {
    res.status(500).json({ error: redactToken(err.message) });
  }
});

// Download tickets: the same idea as relay tickets. Only a link this app
// issued for one file works, for long enough to finish a large download.
export const DOWNLOAD_TICKET_TTL_MS = 24 * 60 * 60 * 1000;
