import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
  isAuthError,
  shouldAttempt,
  recordFailure,
  recordSuccess,
  getBackoffInfo,
  listBackedOff,
} from './server-backoff.js';

// State is module-level, so every test uses its own server key.

// The schedule moves on only when a failure arrives after the pause before it
// has run out, so these tests move the clock instead of waiting.
const START = new Date('2026-01-01T00:00:00Z').getTime();
const atSeconds = (seconds) => setSystemTime(new Date(START + seconds * 1000));
afterEach(() => {
  setSystemTime();
});

describe('server backoff', () => {
  test('an unknown or empty server is always attempted', () => {
    expect(shouldAttempt('never-failed')).toBe(true);
    expect(shouldAttempt('')).toBe(true);
    expect(getBackoffInfo('never-failed')).toBeNull();
  });

  test('connection failures follow the 30s, 120s, 300s schedule, each one after the pause before it has run out', () => {
    const key = 'schedule';
    atSeconds(0);
    recordFailure(key, new Error('ECONNREFUSED'));
    expect(shouldAttempt(key)).toBe(false);
    expect(getBackoffInfo(key)).toMatchObject({ failures: 1, backoffSeconds: 30, revoked: false });
    atSeconds(31);
    expect(shouldAttempt(key)).toBe(true);
    recordFailure(key, new Error('ECONNREFUSED'));
    expect(getBackoffInfo(key)).toMatchObject({ failures: 2, backoffSeconds: 120 });
    atSeconds(31 + 121);
    recordFailure(key, new Error('ECONNREFUSED'));
    expect(getBackoffInfo(key)).toMatchObject({ failures: 3, backoffSeconds: 300 });
  });

  test('the schedule caps at one hour', () => {
    const key = 'capped';
    let seconds = 0;
    for (let i = 0; i < 10; i++) {
      atSeconds(seconds);
      recordFailure(key, 'timeout');
      seconds += (getBackoffInfo(key)?.backoffSeconds ?? 0) + 1;
    }
    expect(getBackoffInfo(key)).toMatchObject({ failures: 10, backoffSeconds: 3600, lastError: 'timeout' });
  });

  test('one outage is one strike: failures reported while the server is already paused do not move the schedule on', () => {
    const key = 'seen-by-many';
    atSeconds(0);
    for (let i = 0; i < 8; i++) recordFailure(key, new Error('503 Service Unavailable'));
    expect(getBackoffInfo(key)).toMatchObject({ failures: 1, backoffSeconds: 30 });
    // Nor does one that arrives later in the same pause make the pause longer.
    atSeconds(20);
    recordFailure(key, new Error('503 Service Unavailable'));
    expect(getBackoffInfo(key)).toMatchObject({ failures: 1, secondsUntilRetry: 10 });
  });

  test('an answer that says the share was revoked lengthens a pause that is already running, without a new strike', () => {
    const key = 'revoked-during-pause';
    atSeconds(0);
    recordFailure(key, new Error('ECONNREFUSED'));
    recordFailure(key, new Error('403 Forbidden'));
    expect(getBackoffInfo(key)).toMatchObject({ failures: 1, backoffSeconds: 86400, revoked: true });
    // And an ordinary failure after that does not shorten it again.
    recordFailure(key, new Error('ECONNREFUSED'));
    expect(getBackoffInfo(key)).toMatchObject({ failures: 1, backoffSeconds: 86400, revoked: true });
  });

  test('auth failures back off for a day and are marked revoked', () => {
    const key = 'revoked';
    recordFailure(key, new Error('401 Unauthorized'));
    expect(getBackoffInfo(key)).toMatchObject({ backoffSeconds: 86400, revoked: true });
    expect(listBackedOff().map((e) => e.serverKey)).toContain(key);
  });

  test('success clears the history', () => {
    const key = 'recovers';
    recordFailure(key, new Error('boom'));
    recordSuccess(key);
    expect(shouldAttempt(key)).toBe(true);
    expect(getBackoffInfo(key)).toBeNull();
  });

  test('isAuthError recognises status codes and words in errors or strings', () => {
    expect(isAuthError(new Error('403 Forbidden'))).toBe(true);
    expect(isAuthError('unauthorized')).toBe(true);
    expect(isAuthError(new Error('500 Internal Server Error'))).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});
