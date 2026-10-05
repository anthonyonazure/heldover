/**
 * Per-server failure backoff.
 *
 * When a Plex server is unreachable (token expired, container down, all
 * connections refused), we don't want every library fetch, health check, and
 * scan loop to keep trying it on every tick. This in-memory tracker enforces
 * exponential backoff per server, and the iteration sites consult it before
 * issuing a network call.
 *
 * Backoff schedule (in seconds): 30, 120, 300, 900, 1800, 3600 (capped).
 * Success at any time clears the failure history.
 *
 * One outage is one strike, however many requests saw it. Every caller asks
 * shouldAttempt before it tries a server, so a failure that is reported while
 * the server is already paused comes from a request that set out before the
 * pause began: the same outage, seen again. It does not move the schedule on.
 * It used to: eight requests that met one failing server together counted as
 * eight outages and took the server away for an hour instead of 30 seconds.
 *
 * Pure in-memory by design — restarts reset the state, which is desirable
 * (a manual restart usually means the operator wants to retry everything).
 */

const SCHEDULE_SECONDS = [30, 120, 300, 900, 1800, 3600];

// A 401/403 is not a transient outage — it's a revoked or expired share. No
// amount of fast retrying fixes it, and hourly retries spam the logs. Back off
// hard (re-check once a day, in case the owner re-shares) instead.
const AUTH_BACKOFF_SECONDS = 86400;

const state = new Map(); // serverKey -> { failures, nextRetryAt, lastError, revoked }

function nowMs() {
  return Date.now();
}

function nextDelayMs(failures) {
  const idx = Math.min(failures - 1, SCHEDULE_SECONDS.length - 1);
  return SCHEDULE_SECONDS[Math.max(0, idx)] * 1000;
}

/**
 * Classify an error/message as an authorization failure (revoked/expired share).
 */
export function isAuthError(error) {
  const msg = (error?.message || String(error || '')).toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden')
  );
}

export function shouldAttempt(serverKey) {
  if (!serverKey) return true;
  const entry = state.get(serverKey);
  if (!entry) return true;
  return nowMs() >= entry.nextRetryAt;
}

export function recordFailure(serverKey, error) {
  if (!serverKey) return;
  const prev = state.get(serverKey);
  const revoked = isAuthError(error);
  const paused = Boolean(prev) && nowMs() < prev.nextRetryAt;
  // Already paused for this outage: nothing changes. The one exception is an
  // answer that says the share was revoked, when the pause on record is an
  // ordinary one. That is news, so the pause becomes the long one, still
  // without a new strike.
  if (paused && (prev.revoked || !revoked)) return;
  const failures = paused ? prev.failures : (prev?.failures || 0) + 1;
  const delay = revoked ? AUTH_BACKOFF_SECONDS * 1000 : nextDelayMs(failures);
  state.set(serverKey, {
    failures,
    nextRetryAt: nowMs() + delay,
    lastError: error?.message || String(error || 'unknown'),
    backoffSeconds: Math.round(delay / 1000),
    revoked,
  });
}

export function recordSuccess(serverKey) {
  if (!serverKey) return;
  if (state.has(serverKey)) state.delete(serverKey);
}

export function getBackoffInfo(serverKey) {
  if (!serverKey) return null;
  const entry = state.get(serverKey);
  if (!entry) return null;
  return {
    failures: entry.failures,
    backoffSeconds: entry.backoffSeconds,
    nextRetryAt: new Date(entry.nextRetryAt).toISOString(),
    secondsUntilRetry: Math.max(0, Math.ceil((entry.nextRetryAt - nowMs()) / 1000)),
    lastError: entry.lastError,
    revoked: !!entry.revoked,
  };
}

export function listBackedOff() {
  const out = [];
  for (const [serverKey, entry] of state.entries()) {
    if (nowMs() < entry.nextRetryAt) {
      out.push({ serverKey, ...getBackoffInfo(serverKey) });
    }
  }
  return out;
}
