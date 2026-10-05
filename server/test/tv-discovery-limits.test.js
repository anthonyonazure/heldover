// Looking for TVs is bounded. Anything on the network can answer the search,
// and one device used to be able to freeze the whole app by answering with a
// huge description, or hundreds of them. A device could also answer with a
// redirect and have this app's request land on another machine, this
// computer included. Stand-ins on 127.0.0.1 only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DESCRIPTION, listen, standInDiscovery } from './tv-stand-ins.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
const tv = await import('../src/tv.js');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Every description request is answered by `bodyFor(url)`; counts them. */
function describeWith(bodyFor) {
  const asked = [];
  globalThis.fetch = async (input) => {
    const url = String(input instanceof URL ? input.href : input);
    asked.push(url);
    return new Response(bodyFor(url), { status: 200, headers: { 'Content-Type': 'text/xml' } });
  };
  return asked;
}

const answer = (address, port = 9197, file = 'desc.xml') => ({ address, location: `http://${address}:${port}/${file}` });

test('an ordinary description is still read correctly', () => {
  assert.deepEqual(tv.readDescription(DESCRIPTION('Living Room', 'uuid:tv-1', '/upnp/control/AVTransport1')), {
    name: 'Living Room',
    model: 'Dummy Model',
    udn: 'uuid:tv-1',
    controlPath: '/upnp/control/AVTransport1',
  });
  // The control address of the AVTransport service, not of the one before it,
  // whichever order the fields are written in.
  const twoServices =
    '<root><device><friendlyName>Den</friendlyName><UDN>uuid:tv-2</UDN><serviceList>' +
    '<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc</controlURL></service>' +
    '<service>\n<controlURL>/av</controlURL>\n<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\n</service>' +
    '<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service>' +
    '</serviceList></device></root>';
  assert.deepEqual(tv.readDescription(twoServices), { name: 'Den', model: null, udn: 'uuid:tv-2', controlPath: '/av' });
  assert.equal(tv.readDescription('<root><device><friendlyName>Speaker</friendlyName></device></root>'), null, 'no AVTransport service');
  assert.equal(tv.readDescription('<service>AVTransport:1<controlURL>/av</controlURL>'), null, 'a service that never closes');
  // An id of absurd length is not used as an id; a name is cut short.
  const long = tv.readDescription(DESCRIPTION('N'.repeat(5000), `uuid:${'x'.repeat(5000)}`));
  assert.equal(long.udn, null);
  assert.equal(long.name.length, 120);
});

test('a huge description is given up on at once, yields no TV and does not freeze the app', async () => {
  // The shape that took over six seconds before: many "<service>" starts,
  // none closed. 320 KB.
  const hostile = '<service>'.repeat(32000) + 'x'.repeat(32000);
  standInDiscovery(() => [answer('192.168.1.50')]);
  describeWith(() => hostile);

  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 10);
  const started = performance.now();
  const devices = await tv.discoverRenderers(100);
  const took = performance.now() - started;
  clearInterval(heartbeat);

  assert.deepEqual(devices, []);
  assert.ok(took < 600, `discovery took ${Math.round(took)} ms`);
  assert.ok(ticks >= 5, `the app kept answering meanwhile (${ticks} ticks)`);

  // The same shape just under the size limit is searched in one pass.
  describeWith(() => '<service>'.repeat(7000));
  const begun = performance.now();
  assert.deepEqual(await tv.discoverRenderers(1), []);
  assert.ok(performance.now() - begun < 300);

  // A real description with padding after it, past the limit, is refused too.
  describeWith(() => DESCRIPTION('Padded TV', 'uuid:padded') + ' '.repeat(64 * 1024));
  assert.deepEqual(await tv.discoverRenderers(1), []);
});

test('reading a description stops at the limit instead of taking in the rest', async () => {
  let sent = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
  standInDiscovery(() => [answer('192.168.1.50')]);
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream(
        {
          pull(controller) {
            // Would go on for 16 MB if it were read to the end.
            if (sent >= 16 * 1024 * 1024) return controller.close();
            sent += chunk.length;
            return controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      ),
      { status: 200 }
    );
  assert.deepEqual(await tv.discoverRenderers(1), []);
  assert.equal(cancelled, true, 'the download was stopped');
  assert.ok(sent <= 96 * 1024, `${sent} bytes were taken in`);
});

test('hundreds of answers are cut down to a few, per device and in total', async () => {
  // One device answering 300 times, each naming a different address on itself.
  standInDiscovery(() => Array.from({ length: 300 }, (_, i) => answer('192.168.1.50', 9000 + i)));
  let asked = describeWith(() => '<root></root>');
  await tv.discoverRenderers(1);
  assert.ok(asked.length >= 1 && asked.length <= 8, `${asked.length} descriptions fetched for one device`);

  // 300 different devices.
  standInDiscovery(() => Array.from({ length: 300 }, (_, i) => answer(`10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`)));
  asked = describeWith(() => '<root></root>');
  await tv.discoverRenderers(1);
  assert.equal(asked.length, 32);
});

// From here on a TV has been found, and the search falls back to the last
// TVs it found when none answer; the tests above rely on running first.
test('a real TV is still found when another device floods the search', async () => {
  standInDiscovery(() => [
    ...Array.from({ length: 300 }, (_, i) => answer('192.168.1.66', 9000 + i)),
    answer('192.168.1.60'),
  ]);
  describeWith((url) => (url.includes('192.168.1.60') ? DESCRIPTION('Real TV', 'uuid:real') : '<root></root>'));
  const devices = await tv.discoverRenderers(1);
  assert.deepEqual(devices.map((d) => d.name), ['Real TV']);
  assert.equal(devices[0].controlUrl, 'http://192.168.1.60:9197/ctl');
});

test('ten callers at once share one search', async () => {
  const made = standInDiscovery(() => [answer('192.168.1.60')]);
  const asked = describeWith(() => DESCRIPTION('Real TV', 'uuid:real'));
  const results = await Promise.all(Array.from({ length: 10 }, () => tv.discoverRenderers(20)));
  assert.equal(made.searches, 1);
  assert.equal(asked.length, 1);
  for (const devices of results) assert.equal(devices.length, 1);
  // Not a cache: the next caller, later, searches again.
  await tv.discoverRenderers(1);
  assert.equal(made.searches, 2);
});

test('a device that answers with a redirect sends this app nowhere', async () => {
  const other = await listen((req, res) => res.end('should never be asked'));
  // Both stand-in TVs live on this computer; the search knows them by a
  // home-network address, which the stub below maps back here.
  const redirectsDescription = await listen((req, res) => {
    res.writeHead(302, { Location: `${other.base}/api/setup/status` });
    res.end();
  });
  const redirectsCommands = await listen((req, res) => {
    if (req.method === 'GET') return res.end(DESCRIPTION('Bouncing TV', 'uuid:bounce'));
    res.writeHead(307, { Location: `${other.base}/api/auth/sign-out-others` });
    return res.end();
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : input);
    url.hostname = '127.0.0.1';
    return realFetch(url, init);
  };
  try {
    standInDiscovery(() => [answer('192.168.1.71', redirectsDescription.port), answer('192.168.1.72', redirectsCommands.port)]);
    const devices = await tv.discoverRenderers(1);
    assert.deepEqual(devices.map((d) => d.name), ['Bouncing TV'], 'the redirected description is not a TV');
    assert.equal(redirectsDescription.seen.length, 1);

    const controlUrl = `http://192.168.1.72:${redirectsCommands.port}/ctl`;
    assert.equal(devices[0].controlUrl, controlUrl);
    const commands = await Promise.allSettled([
      tv.transportState(controlUrl),
      tv.stop(controlUrl),
      tv.play(controlUrl, 'http://192.168.1.10:3001/api/tv/file/a/1?t=x', 'Dummy'),
    ]);

    assert.equal(other.seen.length, 0, `the other machine was asked for ${other.seen.map((r) => `${r.method} ${r.url}`).join(', ')}`);
    assert.deepEqual(commands.map((c) => c.status), ['rejected', 'rejected', 'rejected'], 'a redirected command fails');
    assert.equal(redirectsCommands.seen.filter((r) => r.method === 'POST').length, 3, 'each command reached the TV once');
  } finally {
    for (const s of [other, redirectsDescription, redirectsCommands]) s.server.close();
  }
});

test('a command answered with a huge reply is not read to the end', async () => {
  standInDiscovery(() => []);
  globalThis.fetch = async () => new Response('<errorDescription>'.repeat(60000), { status: 500 });
  const started = performance.now();
  await assert.rejects(tv.stop('http://192.168.1.60:9197/ctl'), /TV rejected Stop$/);
  globalThis.fetch = async () => new Response(`<CurrentTransportState>${'P'.repeat(200000)}</CurrentTransportState>`, { status: 200 });
  assert.equal(await tv.transportState('http://192.168.1.60:9197/ctl'), 'UNKNOWN');
  globalThis.fetch = async () => new Response('<s:Body><CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState></s:Body>', { status: 200 });
  assert.equal(await tv.transportState('http://192.168.1.60:9197/ctl'), 'PAUSED_PLAYBACK');
  assert.ok(performance.now() - started < 500);
});
