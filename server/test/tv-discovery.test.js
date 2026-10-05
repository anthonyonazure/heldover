// A TV is only believed when it describes itself, and commands only go to the
// TV that answered. A fake renderer on the network used to be able to point
// this app at any other machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
const { describesItself, controlUrlFor } = await import('../src/tv.js');

test('a discovery answer must name the home-network address it came from', () => {
  assert.equal(describesItself('http://192.168.1.60:9197/dmr', '192.168.1.60'), true);
  assert.equal(describesItself('http://192.168.1.60:9197/dmr', '192.168.1.77'), false, 'answer from one device naming another');
  assert.equal(describesItself('http://10.0.0.5:8080/desc.xml', '10.0.0.5'), true);
  assert.equal(describesItself('http://8.8.8.8/desc.xml', '8.8.8.8'), false, 'not a home-network address');
  assert.equal(describesItself('http://127.0.0.1:3001/api/cache/clear', '127.0.0.1'), false, 'this computer itself');
  assert.equal(describesItself('http://router.local/desc.xml', '192.168.1.1'), false, 'a name, not an address');
  assert.equal(describesItself('file:///etc/passwd', '192.168.1.77'), false);
  assert.equal(describesItself('not a url', '192.168.1.77'), false);
  assert.equal(describesItself('http://192.168.1.60:9197/dmr', undefined), false);
});

test('commands go to the TV that answered, on any port, and nowhere else', () => {
  const location = 'http://192.168.1.60:9197/dmr';
  assert.equal(
    controlUrlFor(location, '/upnp/control/AVTransport1'),
    'http://192.168.1.60:9197/upnp/control/AVTransport1'
  );
  assert.equal(
    controlUrlFor(location, 'http://192.168.1.60:7676/control'),
    'http://192.168.1.60:7676/control',
    'a full address on the same TV is fine'
  );
  assert.equal(controlUrlFor(location, 'http://192.168.1.1/apply.cgi'), null, 'another machine on the network');
  assert.equal(controlUrlFor(location, 'http://127.0.0.1:3001/api/cache/clear'), null, 'this computer');
  assert.equal(controlUrlFor(location, '//evil.example/control'), null, 'a protocol-relative address');
  assert.equal(controlUrlFor(location, 'javascript:alert(1)'), null);
});
