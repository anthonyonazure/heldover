// Setup, the access PIN, and the app-wide switches they control.

import { useEffect, useState } from 'react';

async function call(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const post = (url, data) => call(url, { method: 'POST', body: JSON.stringify(data || {}) });

export const getAuthStatus = () => call('/api/auth/status');
export const enterPin = (pin) => post('/api/auth/pin', { pin });
export const claimOwner = (code) => post('/api/auth/claim', { code });
export const signOutOthers = () => post('/api/auth/sign-out-others');
export const getSetupStatus = () => call('/api/setup/status');
export const startPlexLink = () => post('/api/setup/plex/pin');
export const checkPlexLink = (id) => post(`/api/setup/plex/pin/${encodeURIComponent(id)}/check`);
export const pastePlexToken = (token) => post('/api/setup/plex/token', { token });
export const saveKeys = (keys) => post('/api/setup/keys', keys);
export const setAccessPin = (pin) => post('/api/setup/access-pin', { pin });
export const setDownloads = (enabled) => post('/api/setup/downloads', { enabled });
export const setLanAccess = (enabled) => post('/api/setup/lan-access', { enabled });
export const saveProfileNames = (names) => post('/api/setup/profiles', { names });
export const completeSetup = () => post('/api/setup/complete');

// The TVs other devices may cast to (owner only). The list takes a few
// seconds: the server looks for TVs on the network before it answers.
export const getTvApprovals = () => call('/api/setup/tvs');
export const approveTv = (id) => post('/api/setup/tvs/approve', { id });
export const removeTv = (id) => post('/api/setup/tvs/remove', { id });

/**
 * Waits for the server to come back after it was asked to restart: it has to
 * be seen gone and then answering again (or simply answering after a few
 * seconds, in case the gap was too short to catch). Gives up quietly after
 * half a minute; the caller reloads the page either way.
 */
export async function waitForRestart() {
  const started = Date.now();
  let wentAway = false;
  while (Date.now() - started < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      if (res.ok && (wentAway || Date.now() - started > 6000)) return;
    } catch {
      wentAway = true;
    }
  }
}

// ---------- App-wide switches ----------

let downloads = false;
const listeners = new Set();

export function setDownloadsKnown(value) {
  downloads = Boolean(value);
  listeners.forEach((cb) => cb(downloads));
}

/** Whether download buttons should appear at all. */
export function useDownloadsEnabled() {
  const [value, setValue] = useState(downloads);
  useEffect(() => {
    listeners.add(setValue);
    setValue(downloads);
    return () => listeners.delete(setValue);
  }, []);
  return value;
}

// Whether this device may change anything (rate, queue, swipe, cast). With no
// PIN set, only the owner's devices can; everyone else can look around.
let canChange = true;
const canChangeListeners = new Set();

export function setCanChangeKnown(value) {
  canChange = Boolean(value);
  canChangeListeners.forEach((cb) => cb(canChange));
}

export function useCanChange() {
  const [value, setValue] = useState(canChange);
  useEffect(() => {
    canChangeListeners.add(setValue);
    setValue(canChange);
    return () => canChangeListeners.delete(setValue);
  }, []);
  return value;
}

// Told each time the server refuses a change from this device.
const refusedListeners = new Set();

export function onChangeRefused(listener) {
  refusedListeners.add(listener);
  return () => refusedListeners.delete(listener);
}

/**
 * When the PIN is turned on from another device, or this device's sign-in is
 * cleared, API calls start coming back 401. Tell the app so it can show the
 * PIN screen rather than a page full of empty rows.
 *
 * The same watcher notices a change being refused (403, "look only"), so one
 * place can explain how to unlock the device instead of every button failing
 * with its own vague message.
 */
export function installPinWatcher(onPinRequired) {
  if (typeof window === 'undefined' || window.__pinWatcherInstalled) return;
  window.__pinWatcherInstalled = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await originalFetch(input, init);
    if (res.status === 401 || res.status === 403) {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/api/') && !url.includes('/api/auth/')) {
        res.clone().json().then((body) => {
          if (res.status === 401 && body?.pinRequired) onPinRequired();
          if (res.status === 403 && body?.lookOnly) {
            setCanChangeKnown(false);
            refusedListeners.forEach((cb) => cb());
          }
        }).catch(() => {});
      }
    }
    return res;
  };
}
