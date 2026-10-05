// Client-side availability lookup with request coalescing.
//
// A grid can hold 200 cards. If each card fetched its own availability that is
// 200 requests on every scroll. Instead every card registers its interest here,
// and everything registered inside one short window goes out as a single batch.

import { getAvailabilityBatch } from './api';
import { useEffect, useState } from 'react';

const CACHE = new Map(); // key -> availability payload
const INFLIGHT = new Set(); // keys already requested, awaiting a response
const SUBSCRIBERS = new Map(); // key -> Set<callback>

let pending = [];
let flushTimer = null;

const BATCH_WINDOW_MS = 60;

function keyFor(type, tmdbId) {
  const mediaType = type === 'show' || type === 'tv' ? 'tv' : 'movie';
  return `${mediaType}:${tmdbId}`;
}

function notify(key, value) {
  const subs = SUBSCRIBERS.get(key);
  if (!subs) return;
  subs.forEach((cb) => cb(value));
}

// The server answers at most this many per request.
const MAX_BATCH = 300;
const RETRY_AFTER_MS = 5000;

async function flush() {
  flushTimer = null;
  const all = pending;
  pending = [];
  for (let i = 0; i < all.length; i += MAX_BATCH) {
    // Not awaited in turn: separate batches can be in flight together.
    sendBatch(all.slice(i, i + MAX_BATCH));
  }
}

async function sendBatch(batch) {
  if (batch.length === 0) return;
  let availability;
  try {
    ({ availability } = await getAvailabilityBatch(batch));
  } catch {
    availability = null;
  }

  const retry = [];
  for (const item of batch) {
    const key = keyFor(item.type, item.tmdbId);
    INFLIGHT.delete(key);
    const value = availability ? availability[key] : undefined;
    if (value) {
      CACHE.set(key, value);
      notify(key, value);
    } else if (SUBSCRIBERS.has(key)) {
      // No answer is not the answer "streams nowhere". Caching it as that
      // hid a title's badges for the rest of the visit; a card that is still
      // on screen asks once more instead.
      retry.push(item);
    }
  }

  if (retry.length > 0 && !batch.retried) {
    const again = retry.map((item) => ({ ...item }));
    again.retried = true;
    setTimeout(() => {
      const still = again.filter((item) => {
        const key = keyFor(item.type, item.tmdbId);
        if (CACHE.has(key) || INFLIGHT.has(key) || !SUBSCRIBERS.has(key)) return false;
        INFLIGHT.add(key);
        return true;
      });
      still.retried = true;
      sendBatch(still);
    }, RETRY_AFTER_MS);
  }
}

function request(type, tmdbId) {
  const key = keyFor(type, tmdbId);
  if (CACHE.has(key) || INFLIGHT.has(key)) return;
  INFLIGHT.add(key);
  pending.push({ type, tmdbId });
  if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WINDOW_MS);
}

/**
 * Availability for one title. Returns null while unknown so callers can render
 * nothing rather than an empty badge row that pops in.
 */
export function useAvailability(item) {
  const tmdbId = item?.tmdbId;
  const type = item?.type || item?.mediaType;
  const key = tmdbId ? keyFor(type, tmdbId) : null;
  const [value, setValue] = useState(() => (key ? CACHE.get(key) || null : null));

  useEffect(() => {
    if (!key || !tmdbId) return undefined;

    const cached = CACHE.get(key);
    if (cached) {
      setValue(cached);
      return undefined;
    }

    const cb = (v) => setValue(v);
    if (!SUBSCRIBERS.has(key)) SUBSCRIBERS.set(key, new Set());
    SUBSCRIBERS.get(key).add(cb);
    request(type, tmdbId);

    return () => {
      const subs = SUBSCRIBERS.get(key);
      if (!subs) return;
      subs.delete(cb);
      if (subs.size === 0) SUBSCRIBERS.delete(key);
    };
  }, [key, type, tmdbId]);

  return value;
}

/** True when the title streams on the given provider slug. */
export function streamsOn(availability, slug) {
  if (!availability) return false;
  return (availability.streaming || []).some((p) => p.slug === slug);
}
