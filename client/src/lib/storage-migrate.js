// What this browser remembered under the app's working name, before it was
// called Heldover: which person is using it, the chosen look, the swipe device
// id and where you were. Moved across once, so a phone that was set up before
// the rename does not quietly fall back to the first profile.
const MOVED = {
  'plexPicker.profileId': 'heldover.profileId',
  'plexPicker.skin': 'heldover.skin',
  'plexPicker.swipeDevice': 'heldover.swipeDevice',
  'plex-picker-session': 'heldover-session',
};

try {
  for (const [from, to] of Object.entries(MOVED)) {
    const value = localStorage.getItem(from);
    if (value === null) continue;
    if (localStorage.getItem(to) === null) localStorage.setItem(to, value);
    localStorage.removeItem(from);
  }
} catch {
  // Storage unavailable (private window): nothing to move.
}
