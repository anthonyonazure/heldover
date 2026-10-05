import crypto from 'crypto';
import { Readable } from 'stream';
import { DOWNLOAD_TICKET_TTL_MS } from './tv.js';
import { PORT, app, ensureServers, getPlexToken } from '../app.js';
import { extractFilename, formatSize } from './settings-profiles.js';
import { plexId } from '../plex-ids.js';
import { NOT_ALLOWED_MESSAGE, allowsDownloads, downloadsAllowedOn } from '../download-permission.js';
import { requireChange } from '../change-gate.js';
import { OffOriginError, plexFetch, sameOriginUrl } from '../plex-fetch.js';
import { isListedItem } from '../plex-library.js';

// A shared server is someone else's machine, and what it says is not taken on
// trust: the address of a file comes from its own answer, and it can answer
// any request with a redirect. Either could point this app, and the token it
// sends along, at another machine (one inside this home network, say). So
// every request to a Plex server in this file goes through plexFetch, and a
// file's address is checked with sameOriginUrl before it is used. The message
// names no address: the address is the other side's choice and can carry a
// token.
const OFF_SERVER_MESSAGE =
  'The Plex server pointed this download at a different address, so Heldover stopped it. Nothing was downloaded.';

const downloadTickets = new Map();

function issueDownloadTicket(serverKey, ratingKey, partIndex) {
  const now = Date.now();
  for (const [ticket, entry] of downloadTickets) {
    if (entry.expires < now) downloadTickets.delete(ticket);
  }
  const ticket = crypto.randomBytes(16).toString('hex');
  downloadTickets.set(ticket, { key: `${serverKey}|${ratingKey}|${partIndex}`, expires: now + DOWNLOAD_TICKET_TTL_MS, running: 0 });
  return ticket;
}

// How many file pass-throughs run at one time. Each one holds a connection to
// the Plex server (which may be someone else's) and one to the device, for as
// long as the device stays connected, and a link works again and again for a
// day. With no ceiling, a device that holds one link could open them without
// end.
//
// Both numbers are set against real use, not against the smallest that would
// do. A download manager splits one file over several connections: Gopeed,
// the one this app hands links to, opens 16 by default, as many as aria2
// allows at most. So one link carries 20: those 16, and room for a connection
// that is opened again before the old one is seen to have closed. Gopeed runs
// 5 downloads at one time by default, which is 80 connections, so 100 in all
// leaves room for that and for other people in the house downloading in a
// browser (one connection each) at the same time.
let maxPerLink = 20;
let maxInAll = 100;
let runningInAll = 0;
// What a refused downloader is told to wait before it asks again. Short: a
// place comes free as soon as one connection finishes its piece.
const RETRY_AFTER_SECONDS = 30;

/** For tests: ceilings small enough to reach with a few requests. */
export function setDownloadLimitsForTests(perLink, inAll) {
  maxPerLink = perLink;
  maxInAll = inAll;
}

/**
 * GET/HEAD /api/download/file/:serverKey/:ratingKey/:partIndex?t=<ticket>
 * Passes one media file through from Plex, with the token added here.
 * Range requests are forwarded, so resumable and multi-connection downloaders
 * work the same as they did against Plex directly. A HEAD gets the same
 * headers and no file is read for it.
 */
app.get('/api/download/file/:serverKey/:ratingKey/:partIndex', async (req, res) => {
  try {
    const { serverKey, ratingKey, partIndex } = req.params;
    const entry = downloadTickets.get(String(req.query.t || ''));
    if (!entry || entry.expires < Date.now() || entry.key !== `${serverKey}|${ratingKey}|${partIndex}`) {
      return res.status(403).json({ error: 'This download link has expired. Open the download menu again.' });
    }

    // A HEAD asks for the headers only, so the Plex server is asked the same
    // way and no file bytes move (the same as /api/tv/file in routes/tv.js).
    // This used to send GET whatever the device sent: a HEAD made the app
    // read the whole file from the Plex server and throw it away.
    const headOnly = req.method === 'HEAD';

    // Listened for from the start, not only once the file is asked for: the
    // questions to the Plex server below can take seconds, and a device that
    // left in the meantime has already closed, so a listener added afterward
    // would never hear it and the file would be read for nobody.
    const controller = new AbortController();
    let counted = false;
    res.on('close', () => {
      controller.abort();
      if (!counted) return;
      counted = false;
      entry.running -= 1;
      runningInAll -= 1;
    });
    if (res.destroyed) return;

    // The ceiling, before anything is asked of the Plex server, so a request
    // that is refused costs that server nothing. Refused at once with a plain
    // answer, never left waiting. A HEAD is not counted: it moves no file.
    if (!headOnly) {
      const full =
        entry.running >= maxPerLink
          ? `This download already has ${maxPerLink} connections open, which is as many as Heldover allows for one file. Set the download manager to use fewer connections.`
          : runningInAll >= maxInAll
            ? 'Heldover is already passing through as many downloads as it allows at one time. Try again when one of them has finished.'
            : null;
      if (full) {
        res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
        return res.status(429).json({ error: full, tooManyDownloads: true });
      }
      counted = true;
      entry.running += 1;
      runningInAll += 1;
    }

    const servers = await ensureServers();
    const server = servers.find((s) => s.clientIdentifier === serverKey);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const serverToken = server.accessToken || getPlexToken();
    // Asked again here, not only when the link was made: a link lasts a day,
    // and the owner may have switched downloads off in the meantime.
    if (!(await downloadsAllowedOn(server, serverToken, plexFetch))) {
      return res.status(403).json({ error: NOT_ALLOWED_MESSAGE, downloadsNotAllowed: true });
    }

    const metaRes = await plexFetch(`${server.uri}/library/metadata/${encodeURIComponent(ratingKey)}`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': serverToken },
      signal: AbortSignal.timeout(15000),
    });
    if (!metaRes.ok) return res.status(502).json({ error: `Plex API error: ${metaRes.status}` });
    const container = (await metaRes.json()).MediaContainer;
    // Only a title from a library the app lists (see the link route below).
    // Asked again here, not only when the link was made: a link lasts a day,
    // and this is the request that fetches the file. It comes first, so
    // nothing is said about a title outside those libraries.
    if (!(await isListedItem(server, container, serverToken))) {
      return res.status(404).json({ error: 'Item not found' });
    }
    if (!server.owned && !allowsDownloads(container)) {
      return res.status(403).json({ error: NOT_ALLOWED_MESSAGE, downloadsNotAllowed: true });
    }
    const item = container?.Metadata?.[0];
    const parts = (item?.Media || []).flatMap((m) => (m.Part || []).filter((p) => p.key));
    const part = parts[Number(partIndex)];
    if (!part) return res.status(404).json({ error: 'File not found' });

    // Checked again here, not only when the link was made: the server is asked
    // afresh each time and may give a different address the second time.
    const fileUrl = sameOriginUrl(server.uri, part.key);

    // The device left while the questions above were being answered: there is
    // nobody to send the file to, so it is not asked for.
    if (controller.signal.aborted) return;
    const upstream = await plexFetch(fileUrl, {
      method: headOnly ? 'HEAD' : 'GET',
      headers: { 'X-Plex-Token': serverToken, ...(req.headers.range ? { Range: req.headers.range } : {}) },
      signal: controller.signal,
    });
    if (!upstream.ok || (!headOnly && !upstream.body)) return res.status(upstream.status || 502).end();

    res.status(upstream.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    // The plain name is ASCII only, because a header cannot carry anything
    // else; filename* carries the real name for browsers that read it.
    const filename = extractFilename(part.file);
    const asciiName = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    if (headOnly) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    if (err.name !== 'AbortError') console.error('Error passing a download through:', err.message);
    if (!res.headersSent) res.status(502).json({ error: err instanceof OffOriginError ? OFF_SERVER_MESSAGE : 'Download failed' });
    else res.destroy();
  }
});

/**
 * GET /api/download-url/:serverKey/:ratingKey
 * Returns download links for a media item. The links point at this app.
 *
 * A link copies a whole file and the file route asks for nothing but the
 * link, so making one is a change even though it is sent as GET. Checked here
 * as well as in change-gate.js: that rule goes by the path, and this one holds
 * however the request was routed here.
 */
app.get('/api/download-url/:serverKey/:ratingKey', requireChange, async (req, res) => {
  try {
    const token = getPlexToken();
    const { serverKey, ratingKey } = req.params;

    const servers = await ensureServers();
    const server = servers.find((s) => s.clientIdentifier === serverKey);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const serverToken = server.accessToken || token;
    // A shared server is someone else's library. Links are only made when its
    // owner has allowed downloads for this account, the same rule Plex's own
    // apps follow.
    if (!(await downloadsAllowedOn(server, serverToken, plexFetch))) {
      return res.status(403).json({ error: NOT_ALLOWED_MESSAGE, downloadsNotAllowed: true });
    }

    // The token goes in a header, as it does on the file route, so it is never
    // part of an address that could end up in a log line or an error.
    const metaRes = await plexFetch(`${server.uri}/library/metadata/${plexId(ratingKey)}`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': serverToken },
      signal: AbortSignal.timeout(15_000),
    });

    if (!metaRes.ok) {
      return res.status(metaRes.status).json({ error: `Plex API error: ${metaRes.status} ${metaRes.statusText}` });
    }

    const data = await metaRes.json();
    // Only a title from a library the app lists: a movie or show library.
    // The number in the request could name anything on the server (a photo,
    // a music track), and the server's token would fetch it. Plex's answer
    // says which library the item is in, so it is checked here, after that
    // one read and before a link is made or anything about the item is said.
    if (!(await isListedItem(server, data, serverToken))) {
      return res.status(404).json({ error: 'Item not found' });
    }
    if (!server.owned && !allowsDownloads(data.MediaContainer)) {
      return res.status(403).json({ error: NOT_ALLOWED_MESSAGE, downloadsNotAllowed: true });
    }
    const item = data.MediaContainer?.Metadata?.[0];

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const downloads = [];

    for (const media of (item.Media || [])) {
      for (const part of (media.Part || [])) {
        if (!part.key) continue;
        // No link for a file the server places anywhere but on itself. The
        // whole title is refused, not only this file: a server that answers
        // like this is not one to copy from.
        sameOriginUrl(server.uri, part.key);

        const filename = extractFilename(part.file);
        // A link to this app, not to the Plex server. The Plex link carried
        // the friend's share token, and anyone who asked for it could keep
        // using that token from anywhere, long after leaving the house.
        const partIndex = downloads.length;
        const ticket = issueDownloadTicket(serverKey, ratingKey, partIndex);
        const downloadUrl = `/api/download/file/${encodeURIComponent(serverKey)}/${encodeURIComponent(ratingKey)}/${partIndex}?t=${ticket}`;

        downloads.push({
          url: downloadUrl,
          filename,
          size: part.size || 0,
          sizeFormatted: formatSize(part.size),
          resolution: media.videoResolution || null,
          videoCodec: media.videoCodec || null,
          audioCodec: media.audioCodec || null,
          audioChannels: media.audioChannels || null,
          container: part.container || media.container || null,
          width: media.width || null,
          height: media.height || null,
          bitrate: media.bitrate || null,
        });
      }
    }

    res.json({ downloads, title: item.title, year: item.year });
  } catch (err) {
    console.error('Error getting download URL:', err.message);
    if (err instanceof OffOriginError) return res.status(502).json({ error: OFF_SERVER_MESSAGE });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/download/gopeed
 * Send a download URL to Gopeed's API.
 */
app.post('/api/download/gopeed', requireChange, async (req, res) => {
  try {
    const { url, filename } = req.body || {};

    // Only a download link this app issued, and only to the downloader set in
    // the server's own settings. Both used to come from the request, which let
    // any caller make this app post to any address it named.
    // Normalised before checking, so "/api/download/file/../../other" cannot
    // pass the prefix test and then resolve somewhere else.
    let normalised = null;
    try {
      const parsed = new URL(String(url), 'http://127.0.0.1');
      if (parsed.origin === 'http://127.0.0.1' && parsed.pathname.startsWith('/api/download/file/')) {
        normalised = `${parsed.pathname}${parsed.search}`;
      }
    } catch {
      normalised = null;
    }
    if (!normalised) {
      return res.status(400).json({ error: 'url must be a download link from this app' });
    }
    const fullUrl = `http://127.0.0.1:${PORT}${normalised}`;

    const baseUrl = process.env.GOPEED_URL || 'http://localhost:9999';

    const gopeedRes = await fetch(`${baseUrl}/api/v1/tasks`, {
      signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        req: {
          url: fullUrl,
          extra: filename ? { name: filename } : undefined,
        },
      }),
    });

    if (!gopeedRes.ok) {
      const errText = await gopeedRes.text().catch(() => '');
      return res.status(gopeedRes.status).json({
        error: `Gopeed API error: ${gopeedRes.status} ${gopeedRes.statusText}`,
        details: errText,
      });
    }

    const result = await gopeedRes.json();
    res.json({ success: true, taskId: result.id || result.data?.id || null });
  } catch (err) {
    console.error('Error sending to Gopeed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
