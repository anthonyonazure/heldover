// Where you were: the open library, filters and scroll position, kept so a
// reload puts you back.

export const SESSION_KEY = 'heldover-session';

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    // Private windows and cleared site data both land here, and neither is a
    // reason to fail to start.
    return {};
  }
}

export function saveSession(patch) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...loadSession(), ...patch }));
  } catch {
    // Out of quota or storage disabled: forgetting where you were is a far
    // smaller problem than refusing to run.
  }
}

export function parseHash(hash) {
  if (!hash) return { kind: 'home' };
  const clean = hash.replace(/^#\/?/, '');
  if (clean.startsWith('view/')) return { kind: 'view', slug: clean.slice(5) };
  if (clean === 'wrapped') return { kind: 'wrapped' };
  return { kind: 'home' };
}
