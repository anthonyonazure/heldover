// Every answer carries the hardening headers, the framing guard is present,
// Express no longer names itself, and HSTS appears only on an https request.
// The middleware is pure (it reads req, sets headers, calls next), so it is
// tested directly without starting a server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { securityHeaders } = await import('../src/security-headers.js');

const run = (req) => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  let nexted = false;
  securityHeaders(req, res, () => { nexted = true; });
  return { headers, nexted };
};
const plain = () => ({ secure: false, headers: {} });

test('the framing guard is set, both ways', () => {
  const { headers } = run(plain());
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Content-Security-Policy'], "frame-ancestors 'none'");
});

test('content-type guessing, referrer leak and features are all shut off', () => {
  const { headers } = run(plain());
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Permissions-Policy'], /camera=\(\)/);
  assert.match(headers['Permissions-Policy'], /geolocation=\(\)/);
});

test('the window and its resources are isolated from other origins', () => {
  const { headers } = run(plain());
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
  // COEP stays off, or an outside image with no CORP header would blank.
  assert.equal(headers['Cross-Origin-Embedder-Policy'], undefined);
});

test('the request is passed on, not stopped', () => {
  assert.equal(run(plain()).nexted, true);
});

test('HSTS is silent on plain http and set on https', () => {
  assert.equal(run(plain()).headers['Strict-Transport-Security'], undefined);
  assert.ok(run({ secure: true, headers: {} }).headers['Strict-Transport-Security']);
  assert.ok(run({ secure: false, headers: { 'x-forwarded-proto': 'https' } }).headers['Strict-Transport-Security']);
});

test('the CSP sets only frame-ancestors, so it cannot blank the app', () => {
  // A default-src or script-src here would have to match the built bundle
  // exactly; frame-ancestors alone governs nothing the page loads.
  const csp = run(plain()).headers['Content-Security-Policy'];
  assert.doesNotMatch(csp, /default-src|script-src|style-src/);
});
