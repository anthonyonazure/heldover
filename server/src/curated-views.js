import { openRatingsDb } from './db.js';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const db = openRatingsDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS curated_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    filters_json TEXT NOT NULL,
    server_key TEXT,
    library_key TEXT,
    edit_pin TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

const insertView = db.prepare(`
  INSERT INTO curated_views (slug, name, description, filters_json, server_key, library_key, edit_pin)
  VALUES (@slug, @name, @description, @filters_json, @server_key, @library_key, @edit_pin)
`);
const updateView = db.prepare(`
  UPDATE curated_views
  SET name = @name, description = @description, filters_json = @filters_json,
      server_key = @server_key, library_key = @library_key, updated_at = datetime('now')
  WHERE slug = @slug
`);
const deleteView = db.prepare('DELETE FROM curated_views WHERE slug = ?');
const storeEditPin = db.prepare('UPDATE curated_views SET edit_pin = ? WHERE slug = ?');
const selectBySlug = db.prepare('SELECT * FROM curated_views WHERE slug = ?');
const selectAll = db.prepare('SELECT * FROM curated_views ORDER BY updated_at DESC');

function generateSlug() {
  return randomBytes(4).toString('hex');
}

// ---------- Edit PIN ----------
//
// The person who publishes a view can lock it, so that only someone who knows
// the edit PIN can change or delete it. The PIN is kept the way the access PIN
// is (config.js): salted and hashed, so reading the database does not give it
// away. It lives in the one edit_pin column as "scrypt$<salt>$<hash>".
//
// Views locked before this was added hold the PIN as it was typed. Those keep
// working: the first time the right PIN is given, it is replaced by its hash.

const EDIT_PIN_MIN = 4;
const EDIT_PIN_MAX = 200;
// What is read from a request at all. Wider than a new PIN may be, so a view
// locked before the limits existed can still be opened with whatever it has.
const TYPED_MAX = 1000;
const HASHED = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{64})$/;

/** Thrown when a locked view is changed without its PIN. `guessed`: a PIN was given, and it was wrong. */
export class EditPinError extends Error {
  constructor(guessed) {
    super(guessed ? 'That edit PIN is not right' : 'This view is locked. Enter its edit PIN to change or delete it.');
    this.name = 'EditPinError';
    this.guessed = guessed;
  }
}

/** Thrown when a new view cannot be saved as asked; the message is for the person. */
export class ViewInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewInputError';
  }
}

/** A PIN as typed: a short string, or a number sent without quotes. Anything else is no PIN. */
function typedPin(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length > 0 && value.length <= TYPED_MAX ? value : null;
}

function hashEditPin(pin, salt = randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

/** Compared in the same time whether the first character differs or the last. */
function sameBytes(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Stops unless the view is unlocked or `given` is its edit PIN.
 * @param {{ slug: string, edit_pin: string | null }} row
 */
function requireEditPin(row, given) {
  if (!row.edit_pin) return;
  const pin = typedPin(given);
  if (!pin) throw new EditPinError(false);

  const hashed = HASHED.exec(row.edit_pin);
  if (hashed) {
    const [, salt, stored] = hashed;
    if (!sameBytes(scryptSync(pin, salt, 32), Buffer.from(stored, 'hex'))) throw new EditPinError(true);
    return;
  }
  // A PIN saved as typed, from before they were hashed. Digests of the two
  // are compared, so their lengths do not show in the timing either.
  const digest = (text) => createHash('sha256').update(String(text)).digest();
  if (!sameBytes(digest(pin), digest(row.edit_pin))) throw new EditPinError(true);
  storeEditPin.run(hashEditPin(pin), row.slug);
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    filters: row.filters_json ? JSON.parse(row.filters_json) : {},
    has_pin: !!row.edit_pin,
    edit_pin: undefined,
    filters_json: undefined,
  };
}

export function createCuratedView({ name, description, filters, serverKey, libraryKey, editPin }) {
  if (!name) throw new Error('name is required');
  // A new PIN has a minimum length. One character could be found in a handful
  // of tries, however slowly guesses are let through.
  let storedPin = null;
  if (editPin !== undefined && editPin !== null && editPin !== '') {
    const pin = typedPin(editPin);
    if (!pin || pin.length < EDIT_PIN_MIN || pin.length > EDIT_PIN_MAX) {
      throw new ViewInputError(`The edit PIN needs ${EDIT_PIN_MIN} or more characters (${EDIT_PIN_MAX} at most)`);
    }
    storedPin = hashEditPin(pin);
  }
  const slug = generateSlug();
  insertView.run({
    slug,
    name,
    description: description || null,
    filters_json: JSON.stringify(filters || {}),
    server_key: serverKey || null,
    library_key: libraryKey || null,
    edit_pin: storedPin,
  });
  return hydrate(selectBySlug.get(slug));
}

export function updateCuratedView(slug, { name, description, filters, serverKey, libraryKey, editPin }) {
  const existing = selectBySlug.get(slug);
  if (!existing) return null;
  requireEditPin(existing, editPin);
  updateView.run({
    slug,
    name: name ?? existing.name,
    description: description ?? existing.description,
    filters_json: JSON.stringify(filters ?? JSON.parse(existing.filters_json)),
    server_key: serverKey ?? existing.server_key,
    library_key: libraryKey ?? existing.library_key,
  });
  return hydrate(selectBySlug.get(slug));
}

export function deleteCuratedView(slug, editPin) {
  const existing = selectBySlug.get(slug);
  if (!existing) return false;
  requireEditPin(existing, editPin);
  const result = deleteView.run(slug);
  return result.changes > 0;
}

export function getCuratedView(slug) {
  return hydrate(selectBySlug.get(slug));
}

export function listCuratedViews() {
  return selectAll.all().map(hydrate);
}
