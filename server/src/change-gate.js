// Looking is open; changing is not.
//
// Every request that changes something needs a device that has entered the PIN
// or is the owner (see canChange in auth.js). The rule is applied here, once,
// by the kind of request rather than route by route, so a route added later is
// covered without anyone remembering to protect it.

import { canChange } from './auth.js';

const CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Requests that are sent as POST but only ask a question: nothing is saved,
// played or sent anywhere. Sign-in has to stay open or nobody could ever
// prove themselves. Setup routes have their own, stricter, owner-only rule.
const ASKS_ONLY = [
  /^\/auth\//,
  /^\/setup\//,
  /^\/ask$/,
  /^\/voice\/parse$/,
  /^\/availability\/batch$/,
  /^\/library-match$/,
  /^\/status\/check$/,
];

// The reverse: sent as GET, but it hands out links that copy whole files.
const ACTS_ANYWAY = [/^\/download-url\//];

/**
 * Does this request change something? `path` is the part after /api.
 *
 * Express matches a route in any letter case and with or without one slash at
 * the end, so this rule reads the path the same way. It used to compare the
 * path as the device spelled it: /DOWNLOAD-URL/... reached the download-link
 * route but was not recognized here, and a look-only device got links.
 */
export function isChange(method, path) {
  const route = String(path || '').toLowerCase();
  // With and without the slash at the end: the lists hold both whole routes
  // ("/ask") and beginnings of routes ("/auth/").
  const spellings = route.length > 1 && route.endsWith('/') ? [route, route.slice(0, -1)] : [route];
  const listed = (patterns) => patterns.some((pattern) => spellings.some((spelling) => pattern.test(spelling)));
  if (listed(ACTS_ANYWAY)) return true;
  if (!CHANGING_METHODS.has(method)) return false;
  return !listed(ASKS_ONLY);
}

function refuse(res) {
  res.status(403).json({
    error:
      'This device can look around but not change anything. Enter the settings code on it, or ask the owner to set a PIN.',
    lookOnly: true,
  });
}

/** Applied to everything under /api, after the PIN check. */
export function changeGate(req, res, next) {
  if (!isChange(req.method, req.path) || canChange(req)) return next();
  refuse(res);
}

/**
 * The same rule, put on one route by name. For a route whose answer is itself
 * a way to act (a download link), so it is guarded where the link is made and
 * not only by the lists above, which someone may edit later.
 */
export function requireChange(req, res, next) {
  if (canChange(req)) return next();
  refuse(res);
}
