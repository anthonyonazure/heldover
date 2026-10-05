// Response headers that harden every page and answer this server sends.
//
// A web scanner (Nikto) on a copy of the install flagged that these were
// missing and that Express announced itself in X-Powered-By. None of it let
// anyone in on its own, but they are free to set and they close the "another
// page frames us" and "another site reads us" doubts the code review raised.
//
// Deliberately narrow. This does NOT set a script or style policy, because the
// client is a built bundle whose exact inline hashes would have to be kept in
// step with every rebuild; a wrong one there is a blank page. It sets only the
// headers that cannot break a same-origin app:
//   - frame-ancestors 'none' (and the older X-Frame-Options): nothing may show
//     this app inside a frame. The desktop app loads it as its own window, not
//     a frame, so it is unaffected. This is what stops a framed copy on the
//     same computer from acting as the owner.
//   - nosniff: a browser must trust the content type we send, not guess from
//     the bytes.
//   - Referrer-Policy no-referrer: the address of a page here never travels to
//     an outside site in a Referer header (poster and logo hosts, say).
//   - Permissions-Policy: the page asks for none of the camera, microphone,
//     location or payment features, so a framed or injected script cannot
//     either.
//   - HSTS, only on a connection that already arrived over https, so it is
//     inert on the home network and real for a public https deployment.

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Site isolation. These two keep this app's window and its resources from
  // being tied to, or embedded by, a page from another origin. They are safe
  // for a same-origin app: the page loads its own resources as before.
  // Cross-Origin-Embedder-Policy (require-corp) is deliberately NOT set: it
  // would refuse to load an outside image (a TMDB or Fanart logo) that does
  // not send its own cross-origin-resource header, and blank it.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // req.secure is true behind a correctly configured TRUST_PROXY; the header
  // check covers a proxy that terminates TLS and forwards plain http.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}
