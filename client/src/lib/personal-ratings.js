// Thumbs are kept per Plex server.
//
// A rating key is only unique inside one server, so a thumb is looked up by
// server and key together. Thumbs saved before the server was stored have no
// server_key; one of those belongs to an item only when the key matches and
// the stored title and year agree with it. The same rule lives on the server
// in server/src/server-keyed.js.

function keyOf(item) {
  return String(item.ratingKey || item.key || '');
}

function sameFilm(row, item) {
  if (!row.title) return true;
  if (String(row.title).toLowerCase() !== String(item.title || '').toLowerCase()) return false;
  return row.year == null || Number(row.year) === Number(item.year);
}

/**
 * Turns the rows from /api/ratings/personal into a lookup:
 * ratingFor(item, serverKey) gives 'up', 'down' or undefined.
 */
export function ratingLookup(rows) {
  const byServer = new Map();
  const older = new Map();
  for (const row of rows) {
    if (!row.plex_key) continue;
    if (row.server_key) byServer.set(`${row.server_key}:${row.plex_key}`, row.rating);
    else older.set(String(row.plex_key), row);
  }
  return (item, serverKey) => {
    const key = keyOf(item);
    const server = item.serverKey || serverKey;
    const own = server ? byServer.get(`${server}:${key}`) : undefined;
    if (own) return own;
    const row = older.get(key);
    return row && sameFilm(row, item) ? row.rating : undefined;
  };
}

/** The rows after one item's thumb changed. A rating of null means it was removed. */
export function withRatingChange(rows, item, serverKey, rating) {
  const key = keyOf(item);
  const server = item.serverKey || serverKey || null;
  const rest = rows.filter((row) => {
    if (String(row.plex_key) !== key) return true;
    if (row.server_key) return row.server_key !== server;
    return !sameFilm(row, item);
  });
  if (!rating) return rest;
  return [{ server_key: server, plex_key: key, title: item.title, year: item.year || null, rating }, ...rest];
}
