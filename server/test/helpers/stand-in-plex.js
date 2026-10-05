// A stand-in Plex server on 127.0.0.1 for the library tests, and the plex.tv
// answer that names it. Dummy data only: nothing here reaches a real Plex
// server, plex.tv or a rating service.
//
// The stand-in keeps a record of every request it answers, so a test can say
// "this section was never asked for" or "one read, not four".

import http from 'http';

export const DUMMY_TOKEN = 'dummy-server-token';
// What the stand-in hands out when it is asked for a short-lived token.
export const DUMMY_SHORT_TOKEN = 'dummy-short-lived-token';

/**
 * Start a stand-in Plex server.
 *
 * @param {object} options
 * @param {string} options.serverKey - what the server says it is at /identity
 * @param {Array} options.sections - [{ key, type, title }], as /library/sections lists them
 * @param {object} options.items - { '<section key>': [Plex metadata items] }
 * @param {number} [options.pageDelayMs] - hold every library page this long
 * @param {object} [options.leaves] - { '<rating key>': [what /allLeaves lists under that item] }
 * @param {Buffer} [options.file] - the bytes served for any address under /library/parts/
 * @param {Array} [options.players] - what /clients lists
 *
 * One item is also answered by its number, as Plex does: /library/metadata/<id>
 * and /library/metadata/<id>/allLeaves. Both answers say which section the
 * item is in (librarySectionID), the way a real server does.
 */
export async function startStandInPlex({ serverKey, sections, items, pageDelayMs = 0, leaves = {}, file = Buffer.alloc(0), players = [] }) {
  const plex = {
    serverKey,
    // Every request that carried the token: { path, section, start, tokenIn },
    // where tokenIn is 'header' or 'address'.
    seen: [],
    // Set true to make the list of sections fail, as a server in trouble does.
    sectionListDown: false,
    // What the server says about where an item is, when that differs from
    // where it was put: rating key -> section key, or null for an answer that
    // names no section at all.
    saysSection: new Map(),
    /** How many requests were made for exactly this path. */
    asked(path) {
      return plex.seen.filter((r) => r.path === path).length;
    },
    pageDelayMs,
    // Sections with a page being answered right now, and the most ever at once.
    sectionsBusy: new Map(),
    mostSectionsBusy: 0,
    /** How many times the first page of a section was asked for: one per read of the library. */
    readsOf(section) {
      return plex.seen.filter((r) => r.section === String(section) && r.start === 0).length;
    },
    /** Every page request for a section. */
    pagesOf(section) {
      return plex.seen.filter((r) => r.section === String(section)).length;
    },
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  /** The item with this rating key and the section it was put in, or null. */
  const find = (id) => {
    for (const [section, list] of Object.entries(items)) {
      for (const item of list) {
        if (String(item.ratingKey) === id) return { item, section };
        const leaf = (leaves[item.ratingKey] || []).find((l) => String(l.ratingKey) === id);
        if (leaf) return { item: leaf, section };
      }
    }
    return null;
  };
  /** { librarySectionID } as this server reports it for an item, or {} when it names none. */
  const sectionSaid = (id, section) => {
    const said = plex.saysSection.has(id) ? plex.saysSection.get(id) : section;
    return said === null ? {} : { librarySectionID: Number(said) };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stand-in');
    if (url.pathname === '/identity') {
      return json(res, 200, { MediaContainer: { machineIdentifier: serverKey } });
    }
    // The token may arrive as a header or in the address; both are the server's token.
    const inAddress = url.searchParams.get('X-Plex-Token');
    const token = req.headers['x-plex-token'] || inAddress;
    if (token !== DUMMY_TOKEN) return json(res, 401, { error: 'unauthorized' });

    const page = url.pathname.match(/^\/library\/sections\/(\d+)\/all$/);
    plex.seen.push({
      path: url.pathname,
      section: page ? page[1] : null,
      start: page ? Number(url.searchParams.get('X-Plex-Container-Start') || 0) : null,
      tokenIn: inAddress ? 'address' : 'header',
    });

    if (url.pathname === '/library/sections') {
      if (plex.sectionListDown) return json(res, 503, { error: 'unavailable' });
      return json(res, 200, { MediaContainer: { Directory: sections } });
    }

    if (page) {
      const all = items[page[1]];
      if (!all) return json(res, 404, { error: 'no such section' });
      const start = Number(url.searchParams.get('X-Plex-Container-Start') || 0);
      const size = Number(url.searchParams.get('X-Plex-Container-Size') || all.length);
      const slice = all.slice(start, start + size);
      const answer = () => {
        const busy = (plex.sectionsBusy.get(page[1]) || 1) - 1;
        if (busy > 0) plex.sectionsBusy.set(page[1], busy);
        else plex.sectionsBusy.delete(page[1]);
        json(res, 200, { MediaContainer: { size: slice.length, totalSize: all.length, Metadata: slice } });
      };
      plex.sectionsBusy.set(page[1], (plex.sectionsBusy.get(page[1]) || 0) + 1);
      plex.mostSectionsBusy = Math.max(plex.mostSectionsBusy, plex.sectionsBusy.size);
      if (plex.pageDelayMs > 0) setTimeout(answer, plex.pageDelayMs);
      else answer();
      return undefined;
    }

    const byId = url.pathname.match(/^\/library\/metadata\/(\d+)(\/allLeaves)?$/);
    if (byId) {
      const found = find(byId[1]);
      if (!found) return json(res, 404, { error: 'no such item' });
      const section = sectionSaid(byId[1], found.section);
      if (byId[2]) {
        const under = leaves[byId[1]] || [];
        return json(res, 200, { MediaContainer: { size: under.length, ...section, Metadata: under } });
      }
      return json(res, 200, { MediaContainer: { size: 1, allowSync: true, ...section, Metadata: [{ ...found.item, ...section }] } });
    }

    if (url.pathname.startsWith('/library/parts/')) {
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('accept-ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const from = Number(range[1]);
        const to = range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
        res.writeHead(206, { 'content-range': `bytes ${from}-${to}/${file.length}`, 'content-length': to - from + 1 });
        return res.end(file.subarray(from, to + 1));
      }
      res.writeHead(200, { 'content-length': file.length });
      return res.end(file);
    }

    if (url.pathname === '/clients') return json(res, 200, { MediaContainer: { Server: players } });
    if (url.pathname === '/security/token') return json(res, 200, { MediaContainer: { token: DUMMY_SHORT_TOKEN } });

    return json(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  plex.uri = `http://127.0.0.1:${server.address().port}`;
  /** Stop answering, as a server that has gone offline. */
  plex.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  /** What plex.tv says about this server: one the account owns, at this address. */
  plex.resource = () => ({
    name: `Stand-in ${serverKey}`,
    provides: 'server',
    owned: true,
    presence: true,
    clientIdentifier: serverKey,
    accessToken: DUMMY_TOKEN,
    connections: [{ uri: plex.uri, local: true, protocol: 'http' }],
  });
  return plex;
}

/**
 * Answer plex.tv's server list from the stand-ins and let 127.0.0.1 through.
 * Anything else is refused and written down, so a test can show that nothing
 * left this computer. Returns that list of refused addresses.
 *
 * With `homeNetwork`, a 192.168 address (a TV, a Plex player: the app only
 * sends those commands to private addresses, never to 127.0.0.1) is reached
 * on this computer at the same port.
 */
export function stubPlexTv(standIns, { homeNetwork = false } = {}) {
  const realFetch = globalThis.fetch;
  const refused = [];
  globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    if (homeNetwork && url.hostname.startsWith('192.168.')) {
      url.hostname = '127.0.0.1';
      return realFetch(url, init);
    }
    if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/resources') {
      return new Response(JSON.stringify(standIns.map((p) => p.resource())), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    refused.push(`${url.hostname}${url.pathname}`);
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return refused;
}

/**
 * A stand-in Plex player (the Plex app on a TV or a phone) on this computer.
 * It remembers every command it is sent. `listing` is what a Plex server's
 * /clients says about it; the address there is a home-network one, which
 * stubPlexTv(..., { homeNetwork: true }) brings back to this computer.
 */
export async function startStandInPlayer({ machineIdentifier = 'dummy-player', address = '192.168.1.70' } = {}) {
  const player = { commands: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stand-in');
    player.commands.push({ path: url.pathname, key: url.searchParams.get('key'), token: url.searchParams.get('X-Plex-Token') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  player.listing = { name: 'Dummy Player', machineIdentifier, address, port: server.address().port, protocol: 'http' };
  player.stop = () => new Promise((resolve) => server.close(resolve));
  return player;
}

/** Listen on a free port on this computer and return a function that calls the app. */
export async function listenForTest(app) {
  const listener = await new Promise((resolve) => {
    const l = app.listen(0, '127.0.0.1', () => resolve(l));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  /**
   * GET or POST the app. `lookOnly` sends the request as another device on the
   * network; `signal` lets a test hang up before the answer, as a device that
   * has gone away does.
   */
  const call = async (method, path, { lookOnly = false, body, signal } = {}) => {
    const res = await fetch(base + path, {
      method,
      signal,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        // A loopback connection that says it was forwarded for another device
        // is not this computer (auth.js isLocal), so the app treats it as a
        // device that may look and change nothing.
        ...(lookOnly ? { 'X-Forwarded-For': '192.168.1.50' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // An answer that is not JSON (Express's own 404 page) has no body to read.
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };
  return { base, call, close: () => new Promise((resolve) => listener.close(resolve)) };
}

/** Wait until `check` returns something truthy, or fail after a few seconds. */
export async function until(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
