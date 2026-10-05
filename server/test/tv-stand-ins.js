// Stand-ins shared by the TV tests: a Plex server, a television, the plex.tv
// answer that lists the server, and the discovery socket. Everything listens
// on 127.0.0.1 and every token is made up. Not a test file itself.

import http from 'http';
import dgram from 'dgram';
import { EventEmitter } from 'events';

export const ACCOUNT_TOKEN = 'DUMMY-ACCOUNT-TOKEN-0000';
export const SHARE_TOKEN = 'DUMMY-SHARE-TOKEN-1111';
export const SERVER_KEY = 'dummyshare1';

/** A small web server on this computer that remembers what it was asked. */
export function listen(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, token: req.headers['x-plex-token'] || null, range: req.headers.range || null });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, seen, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * A Plex server that belongs to someone else. `titles` maps a rating key to
 * { container, videoCodec, audioCodec, key, ratingKey }, where `key` is the
 * file address the server reports (the part a hostile server controls).
 * Anything under /library/parts/ is served from `file`, with Range support;
 * `redirects` maps a path to the address it bounces to.
 */
export function standInPlex({ titles, file, redirects = {} }) {
  return listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (body) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: SERVER_KEY } });
    if (url.pathname === '/') return json({ MediaContainer: { allowSync: false, friendlyName: 'Friend' } });
    // One movie library, and every title below says it is in it: the app
    // casts only titles from the libraries a server lists.
    if (url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Films' }] } });
    const meta = /^\/library\/metadata\/(\d+)$/.exec(url.pathname);
    if (meta && titles[meta[1]]) {
      const t = typeof titles[meta[1]] === 'function' ? titles[meta[1]]() : titles[meta[1]];
      return json({
        MediaContainer: {
          Metadata: [{
            ratingKey: t.ratingKey ?? meta[1],
            librarySectionID: 1,
            type: 'movie',
            title: `Dummy ${meta[1]}`,
            duration: 4000,
            Media: [{
              container: t.container || 'mp4',
              videoCodec: t.videoCodec || 'h264',
              audioCodec: t.audioCodec || 'aac',
              Part: [{ key: t.key }],
            }],
          }],
        },
      });
    }
    if (redirects[url.pathname]) {
      res.writeHead(302, { Location: redirects[url.pathname]() });
      return res.end();
    }
    if (url.pathname.startsWith('/library/parts/')) {
      // Only the holder of the token gets the file, as a real server insists.
      if (req.headers['x-plex-token'] !== SHARE_TOKEN) {
        res.statusCode = 401;
        return res.end();
      }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
        res.setHeader('Content-Length', end - start + 1);
        return res.end(file.subarray(start, end + 1));
      }
      res.setHeader('Content-Length', file.length);
      return res.end(file);
    }
    res.statusCode = 404;
    return res.end();
  });
}

export const DESCRIPTION = (name, udn, controlPath = '/ctl') =>
  `<root><device><friendlyName>${name}</friendlyName><modelName>Dummy Model</modelName><UDN>${udn}</UDN>` +
  '<serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>' +
  `<controlURL>${controlPath}</controlURL></service></serviceList></device></root>`;

/** A television: describes itself, and remembers every command it is sent. */
export async function standInTv({ name = 'Dummy TV', udn = 'uuid:dummy-tv-1' } = {}) {
  const commands = [];
  const tv = await listen((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/xml');
      return res.end(DESCRIPTION(name, udn));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const action = (String(req.headers.soapaction || '').match(/#(\w+)/) || [])[1] || null;
      const uri = (body.match(/<CurrentURI>(.*?)<\/CurrentURI>/) || [])[1] || null;
      commands.push({ action, uri: uri ? uri.replace(/&amp;/g, '&') : null });
      res.setHeader('Content-Type', 'text/xml');
      res.end('<s:Envelope><s:Body><CurrentTransportState>PLAYING</CurrentTransportState></s:Body></s:Envelope>');
    });
    return undefined;
  });
  return { ...tv, commands, name, udn };
}

/**
 * Replaces the network for the code under test. plex.tv answers with one
 * shared server at `plexBase`; a private home address (a TV) is reached on
 * this computer at the same port; this computer is reached for real; anything
 * else fails, so no test can leave the machine.
 */
export function standInNetwork({ plexBase } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/resources') {
      return new Response(
        JSON.stringify([{
          name: 'Dummy Shared Server',
          provides: 'server',
          owned: false,
          presence: true,
          clientIdentifier: SERVER_KEY,
          accessToken: SHARE_TOKEN,
          connections: [{ uri: plexBase, local: false, protocol: 'http' }],
        }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.hostname === '127.0.0.1') return realFetch(url, init);
    if (/^(10\.|192\.168\.)/.test(url.hostname)) {
      url.hostname = '127.0.0.1';
      return realFetch(url, init);
    }
    throw new TypeError('no network in this test');
  };
  return realFetch;
}

/**
 * Replaces the discovery socket. `answers()` returns what comes back from the
 * network on each search: [{ location, address }]. Counts the searches made.
 */
export function standInDiscovery(answers) {
  const made = { searches: 0 };
  dgram.createSocket = () => {
    const socket = new EventEmitter();
    made.searches += 1;
    socket.bind = (done) => setImmediate(done);
    socket.setBroadcast = () => {};
    socket.close = () => {};
    socket.send = () => {
      for (const { location, address } of answers()) {
        socket.emit('message', Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: ${location}\r\n\r\n`), { address, port: 1900 });
      }
    };
    return socket;
  };
  return made;
}
