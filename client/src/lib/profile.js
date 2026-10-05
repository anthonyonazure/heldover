// Who is watching.
//
// Every personal thing the server stores — thumbs, not-interested, the queue —
// is keyed to a profile. Rather than thread that id through the fifty-odd call
// sites in api.js, we tag it onto outgoing API requests in one place. One
// instruction, one location: adding a new endpoint cannot forget to send it.

const STORAGE_KEY = 'heldover.profileId';

let currentProfileId = 1;
const listeners = new Set();

try {
  const stored = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (Number.isFinite(stored) && stored > 0) currentProfileId = stored;
} catch {
  // Private windows and blocked site data both land here; profile 1 is fine.
}

export function getProfileId() {
  return currentProfileId;
}

export function setProfileId(id) {
  currentProfileId = Number(id) || 1;
  try {
    localStorage.setItem(STORAGE_KEY, String(currentProfileId));
  } catch {
    // Not being able to remember the choice is survivable; switching still works.
  }
  listeners.forEach((cb) => cb(currentProfileId));
}

export function onProfileChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Tag every same-origin API call with the current profile. Call once at boot. */
export function installProfileHeader() {
  if (typeof window === 'undefined' || window.__profileHeaderInstalled) return;
  window.__profileHeaderInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const isOwnApi = url.startsWith('/api/') || url.includes(`${window.location.origin}/api/`);
    if (!isOwnApi) return originalFetch(input, init);

    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
    headers.set('X-Profile-Id', String(currentProfileId));
    return originalFetch(input, { ...init, headers });
  };
}
