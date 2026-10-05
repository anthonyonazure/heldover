import { openRatingsDb } from './db.js';
import { plexId } from './plex-ids.js';
import { plexRequest } from './plex-connections.js';
import { acceptedPicture } from './plex-images.js';
import { isListedItem, isListedLibrary, sectionOfItem } from './plex-library.js';

const db = openRatingsDb();

// Create subscription tables
db.exec(`
  CREATE TABLE IF NOT EXISTS show_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    plex_key TEXT,
    guid TEXT,
    server_key TEXT,
    library_key TEXT,
    thumb TEXT,
    last_known_episodes INTEGER DEFAULT 0,
    last_checked_at TEXT,
    new_episodes_count INTEGER DEFAULT 0,
    subscribed_at TEXT DEFAULT (datetime('now')),
    UNIQUE(server_key, plex_key)
  );

  CREATE TABLE IF NOT EXISTS episode_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER REFERENCES show_subscriptions(id) ON DELETE CASCADE,
    episode_title TEXT,
    season_number INTEGER,
    episode_number INTEGER,
    added_at TEXT,
    seen_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Alerts are always looked up by their show, and deleting a show cascades
  -- to its alerts; without this both read the whole table.
  CREATE INDEX IF NOT EXISTS idx_episode_alerts_subscription ON episode_alerts(subscription_id);
`);

// ---------- One alert for one episode ----------
//
// An alert row used to say which show, a title, a season number and an
// episode number, and nothing made a second row for the same episode
// impossible. What counts as new is decided by comparing how many episodes
// the server lists with how many it listed last time, so a list that got
// shorter and then longer again stored the same episodes a second time, and
// a third. The server may be someone else's, nothing limited the rows of one
// check or of one show, and nothing removed a row while the show was followed.
//
// Each row now carries a key for its episode, and a show holds one row per
// key. The key is the season and episode number. Those are what the rows
// already on file hold, so they can be given the same key: Plex's own number
// for the episode was never stored, and it changes when a file is replaced,
// which would alert twice for one episode. The title is not part of the key
// when there is an episode number, because a new episode often arrives as
// "Episode 5" and is given its real title later. An entry with no episode
// number (some shows are filed by date) is told apart by its title instead.

// How much of a title is stored and compared.
const MAX_ALERT_TITLE_LENGTH = 300;

/** A season or episode number as a whole number, or 0 when there is none. */
function wholeNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 999_999 ? n : 0;
}

/** What identifies an episode within one followed show. */
function episodeKey(season, episode, title) {
  const s = wholeNumber(season);
  const e = wholeNumber(episode);
  if (e > 0) return `s${s}e${e}`;
  return `s${s}e0:${String(title ?? '').slice(0, MAX_ALERT_TITLE_LENGTH)}`;
}

// Alerts one check may add for one show: the newest. A whole season arriving
// at once is 10 to 26 episodes; beyond 50 an answer is a show being added in
// bulk, or a server that is not telling the truth, and a list of hundreds of
// alerts is of no use to anyone.
let maxAlertsPerCheck = 50;
// Alerts kept for one show: the newest. Ten full checks, or about twenty
// seasons of new episodes since the show was followed. Seen alerts are kept
// inside this limit on purpose: a seen row is what stops its episode from
// being announced again.
let maxAlertsPerSubscription = 500;
// Unseen alerts handed out by one request: the newest. The panel shows them
// as one list; the count of all of them is given beside it.
let maxAlertsReturned = 200;

/** For tests: limits small enough to reach with a handful of dummy episodes. */
export function setAlertLimitsForTests({ perCheck = maxAlertsPerCheck, perSubscription = maxAlertsPerSubscription, returned = maxAlertsReturned } = {}) {
  maxAlertsPerCheck = perCheck;
  maxAlertsPerSubscription = perSubscription;
  maxAlertsReturned = returned;
}

const alertColumns = new Set(db.prepare('PRAGMA table_info(episode_alerts)').all().map((column) => column.name));
if (!alertColumns.has('episode_key')) db.exec('ALTER TABLE episode_alerts ADD COLUMN episode_key TEXT');

/**
 * Give the alerts already on file their episode key, and keep one row for
 * each episode of a show. Runs at every start and changes nothing once every
 * row has a key. The earliest row of an episode is the one kept, and it is
 * marked seen if any of its copies was: the household has already dealt with
 * that episode. Then each show is cut back to its newest rows.
 * Returns { keyed, repeated, beyondLimit }.
 */
const tidyStoredAlerts = db.transaction(() => {
  const result = { keyed: 0, repeated: 0, beyondLimit: 0 };
  const showsWithUnkeyedRows = db
    .prepare('SELECT DISTINCT subscription_id FROM episode_alerts WHERE episode_key IS NULL AND subscription_id IS NOT NULL')
    .all();
  const rowsOfShow = db.prepare(
    'SELECT id, season_number, episode_number, episode_title, seen_at, episode_key FROM episode_alerts WHERE subscription_id = ? ORDER BY id'
  );
  const removeRow = db.prepare('DELETE FROM episode_alerts WHERE id = ?');
  const setKey = db.prepare('UPDATE episode_alerts SET episode_key = ? WHERE id = ?');
  const setSeen = db.prepare('UPDATE episode_alerts SET seen_at = ? WHERE id = ?');

  for (const { subscription_id } of showsWithUnkeyedRows) {
    const kept = new Map(); // episode key -> the row that stays
    const repeats = [];
    for (const row of rowsOfShow.all(subscription_id)) {
      const key = row.episode_key ?? episodeKey(row.season_number, row.episode_number, row.episode_title);
      const first = kept.get(key);
      if (!first) {
        kept.set(key, { id: row.id, key, needsKey: row.episode_key === null, seenBefore: row.seen_at, seenAt: row.seen_at });
        continue;
      }
      repeats.push(row.id);
      if (row.seen_at && (!first.seenAt || row.seen_at < first.seenAt)) first.seenAt = row.seen_at;
    }
    // Repeats go first, so no two rows ever hold the same key at once.
    for (const id of repeats) removeRow.run(id);
    for (const row of kept.values()) {
      if (row.needsKey) setKey.run(row.key, row.id);
      if (!row.seenBefore && row.seenAt) setSeen.run(row.seenAt, row.id);
    }
    result.keyed += [...kept.values()].filter((row) => row.needsKey).length;
    result.repeated += repeats.length;
  }

  result.beyondLimit = db
    .prepare(
      `DELETE FROM episode_alerts WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY subscription_id ORDER BY id DESC) AS place
           FROM episode_alerts WHERE subscription_id IS NOT NULL
         ) WHERE place > ?
       )`
    )
    .run(maxAlertsPerSubscription).changes;
  return result;
});

// A failure here is said and startup carries on: the cost is repeated alerts
// staying on file, not an app that will not start. New alerts are still
// stored once each (insertAlert below looks before it adds).
try {
  const tidied = tidyStoredAlerts();
  if (tidied.keyed + tidied.repeated + tidied.beyondLimit > 0) {
    console.log(
      `[subscriptions] stored alerts tidied: ${tidied.keyed} given an episode key, ${tidied.repeated} repeats removed, ${tidied.beyondLimit} removed beyond the newest ${maxAlertsPerSubscription} of their show`
    );
  }
  db.exec(`
    -- One row for one episode of one show.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_alerts_once
      ON episode_alerts(subscription_id, episode_key) WHERE episode_key IS NOT NULL;
    -- The unseen list and the badge count read only unseen rows.
    CREATE INDEX IF NOT EXISTS idx_episode_alerts_unseen
      ON episode_alerts(created_at) WHERE seen_at IS NULL;
  `);
} catch (err) {
  console.error('[subscriptions] could not tidy the stored new-episode alerts, so repeated alerts may stay on file:', err.message);
}

// Prepared statements
const stmts = {
  insert: db.prepare(`
    INSERT OR IGNORE INTO show_subscriptions (title, plex_key, guid, server_key, library_key, thumb, last_known_episodes)
    VALUES (@title, @plex_key, @guid, @server_key, @library_key, @thumb, @last_known_episodes)
  `),
  updateEpisodeCount: db.prepare(`
    UPDATE show_subscriptions
    SET last_known_episodes = @last_known_episodes, last_checked_at = datetime('now')
    WHERE id = @id
  `),
  delete: db.prepare('DELETE FROM show_subscriptions WHERE id = ?'),
  getAll: db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM episode_alerts a WHERE a.subscription_id = s.id AND a.seen_at IS NULL) as unseen_count
    FROM show_subscriptions s
    ORDER BY s.subscribed_at DESC
  `),
  getById: db.prepare('SELECT * FROM show_subscriptions WHERE id = ?'),
  getByPlexKey: db.prepare('SELECT * FROM show_subscriptions WHERE plex_key = ?'),
  isSubscribed: db.prepare('SELECT 1 FROM show_subscriptions WHERE plex_key = ?'),
  // Looks before it adds, so an episode is stored once even on a database
  // where the unique index above could not be made.
  insertAlert: db.prepare(`
    INSERT OR IGNORE INTO episode_alerts (subscription_id, episode_key, episode_title, season_number, episode_number, added_at)
    SELECT @subscription_id, @episode_key, @episode_title, @season_number, @episode_number, @added_at
    WHERE NOT EXISTS (
      SELECT 1 FROM episode_alerts WHERE subscription_id = @subscription_id AND episode_key = @episode_key
    )
  `),
  trimAlerts: db.prepare(`
    DELETE FROM episode_alerts
    WHERE subscription_id = ? AND id NOT IN (
      SELECT id FROM episode_alerts WHERE subscription_id = ? ORDER BY id DESC LIMIT ?
    )
  `),
  getAlerts: db.prepare(`
    SELECT * FROM episode_alerts WHERE subscription_id = ? ORDER BY season_number DESC, episode_number DESC
  `),
  getAllUnseenAlerts: db.prepare(`
    SELECT a.*, s.title as show_title, s.thumb as show_thumb, s.plex_key as show_plex_key
    FROM episode_alerts a
    JOIN show_subscriptions s ON a.subscription_id = s.id
    WHERE a.seen_at IS NULL
    ORDER BY a.created_at DESC
    LIMIT ?
  `),
  markAlertSeen: db.prepare("UPDATE episode_alerts SET seen_at = datetime('now') WHERE id = ?"),
  markAllAlertsSeen: db.prepare("UPDATE episode_alerts SET seen_at = datetime('now') WHERE subscription_id = ? AND seen_at IS NULL"),
  getUnseenCount: db.prepare('SELECT COUNT(*) as count FROM episode_alerts WHERE seen_at IS NULL'),
};

/**
 * Subscribe to a show. Fetches current episode count from Plex.
 *
 * Returns the subscription, or null when Plex's answer places the item
 * outside the libraries the app lists. Nothing is stored then, and the route
 * answers 404.
 */
export async function subscribe(item, servers, token) {
  const plexKey = item.plex_key || item.plexKey || item.ratingKey || item.key;
  const serverKey = item.server_key || item.serverKey;

  // Fetch current episode count from Plex
  let episodeCount = 0;
  if (servers && token && serverKey && plexKey) {
    try {
      const server = servers.find((s) => s.clientIdentifier === serverKey);
      if (server) {
        const serverToken = server.accessToken || token;
        // The token is a header, not part of the address, so the error text
        // logged below can never hold it.
        const url = `${server.uri}/library/metadata/${plexId(plexKey)}/allLeaves`;
        const res = await plexRequest(url, {
          headers: { Accept: 'application/json', 'X-Plex-Token': serverToken },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = await res.json();
          // Only a show from a library the app lists. The number in the
          // request could name anything on the server (a photo album, a
          // music artist), and a subscription is read again every hour, with
          // what is found shown as alerts. Plex's answer says which library
          // the item is in; one that names an unlisted library, or none, is
          // refused before anything is stored. When Plex cannot be asked at
          // all the subscription is kept as before, and the hourly check
          // below passes over it once Plex names a library that is not listed.
          if (!(await isListedItem(server, data, serverToken))) return null;
          episodeCount = data.MediaContainer?.size || data.MediaContainer?.Metadata?.length || 0;
        }
      }
    } catch (err) {
      console.error('Error fetching episode count for subscription:', err.message);
    }
  }

  const result = stmts.insert.run({
    title: item.title,
    plex_key: plexKey,
    guid: item.guid || null,
    server_key: serverKey || null,
    library_key: item.library_key || item.libraryKey || null,
    // From the browser: kept only when it is an address the app issued (or a
    // TMDB poster); anything else is stored as no picture.
    thumb: acceptedPicture(item.thumb) || acceptedPicture(item.posterUrl),
    last_known_episodes: episodeCount,
  });

  if (result.changes === 0) {
    // Already subscribed — return existing
    return stmts.getByPlexKey.get(plexKey);
  }

  return stmts.getById.get(result.lastInsertRowid);
}

/**
 * Unsubscribe from a show (cascades to alerts).
 */
export function unsubscribe(id) {
  const result = stmts.delete.run(id);
  return result.changes > 0;
}

/**
 * Get all subscriptions with unseen alert counts.
 */
export function getSubscriptions() {
  return stmts.getAll.all();
}

/**
 * Check if a show is subscribed by plex key.
 */
export function isSubscribed(plexKey) {
  return !!stmts.isSubscribed.get(plexKey);
}

/**
 * Check for new episodes across all subscriptions.
 * Returns subscriptions that have new episodes.
 *
 * One check at a time. The hourly timer, the check inside the six-hour scan
 * and the "check now" route each used to start their own, and two that
 * overlapped both read the same stored counts and both stored the same
 * alerts. A caller that arrives while a check is running waits for that one
 * and gets its answer.
 */
let checkInFlight = null;
export function checkForNewEpisodes(servers, token) {
  if (!checkInFlight) {
    checkInFlight = runEpisodeCheck(servers, token).finally(() => {
      checkInFlight = null;
    });
  }
  return checkInFlight;
}

/** Store the alerts of one show and cut it back to its newest rows. Returns { added, removed }. */
const storeAlerts = db.transaction((subscriptionId, episodes) => {
  let added = 0;
  for (const ep of episodes) {
    const title = String(ep.title || 'Unknown').slice(0, MAX_ALERT_TITLE_LENGTH);
    const season = wholeNumber(ep.parentIndex || ep.seasonNumber);
    const episode = wholeNumber(ep.index || ep.episodeNumber);
    added += stmts.insertAlert.run({
      subscription_id: subscriptionId,
      episode_key: episodeKey(season, episode, title),
      episode_title: title,
      season_number: season,
      episode_number: episode,
      added_at: ep.addedAt
        ? new Date(ep.addedAt * 1000).toISOString()
        : new Date().toISOString(),
    }).changes;
  }
  const removed = stmts.trimAlerts.run(subscriptionId, subscriptionId, maxAlertsPerSubscription).changes;
  return { added, removed };
});

async function runEpisodeCheck(servers, token) {
  if (!servers || !token) return [];

  const subscriptions = stmts.getAll.all();
  const withNew = [];
  let beyondLimit = 0;

  for (const sub of subscriptions) {
    try {
      const server = servers.find((s) => s.clientIdentifier === sub.server_key);
      if (!server) continue;

      const serverToken = server.accessToken || token;
      const url = `${server.uri}/library/metadata/${plexId(sub.plex_key)}/allLeaves`;
      const res = await plexRequest(url, {
        headers: { Accept: 'application/json', 'X-Plex-Token': serverToken },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) continue;

      const data = await res.json();
      // A subscription already on file is not refused here: a show the
      // household follows must not go quiet because an answer left out its
      // library. It is passed over only when Plex names a library the app
      // does not list. Then nothing from the answer is stored or shown, and
      // the subscription itself stays.
      const section = sectionOfItem(data);
      if (section !== null && !(await isListedLibrary(server, section, serverToken))) continue;
      const listed = data.MediaContainer?.Metadata;
      const episodes = Array.isArray(listed) ? listed : [];
      const currentCount = episodes.length;

      if (currentCount > sub.last_known_episodes) {
        // The list is longer than last time: the entries past the old count
        // are taken as new, the newest of them are stored, and one that
        // already has an alert is passed over.
        const newEpisodes = episodes
          .slice(sub.last_known_episodes)
          .filter((ep) => ep && typeof ep === 'object')
          .slice(-maxAlertsPerCheck);

        const stored = storeAlerts(sub.id, newEpisodes);
        beyondLimit += stored.removed;

        // Update the subscription
        stmts.updateEpisodeCount.run({
          id: sub.id,
          last_known_episodes: currentCount,
        });

        // Only what was really stored counts as new: a list that grew back
        // to what it was before announces nothing.
        if (stored.added > 0) {
          withNew.push({
            ...sub,
            newCount: stored.added,
          });
        }
      } else {
        // No new episodes, just update last_checked_at. The count may go
        // down; with one row per episode a later, longer answer cannot store
        // the same episode twice.
        stmts.updateEpisodeCount.run({
          id: sub.id,
          last_known_episodes: currentCount,
        });
      }
    } catch (err) {
      console.error(`Error checking episodes for "${sub.title}":`, err.message);
    }
  }

  if (beyondLimit > 0) {
    console.log(`[subscriptions] alerts removed beyond the newest ${maxAlertsPerSubscription} of their show: ${beyondLimit}`);
  }

  return withNew;
}

/**
 * Get alerts for a specific subscription.
 */
export function getAlerts(subscriptionId) {
  return stmts.getAlerts.all(subscriptionId);
}

/**
 * Get the unseen alerts across all subscriptions, newest first: at most
 * maxAlertsReturned of them. getUnseenAlertCount says how many there are.
 */
export function getAllUnseenAlerts() {
  return stmts.getAllUnseenAlerts.all(maxAlertsReturned);
}

/**
 * Mark a single alert as seen.
 */
export function markAlertSeen(alertId) {
  const result = stmts.markAlertSeen.run(alertId);
  return result.changes > 0;
}

/**
 * Mark all alerts for a subscription as seen.
 */
export function markAllAlertsSeen(subscriptionId) {
  const result = stmts.markAllAlertsSeen.run(subscriptionId);
  return result.changes;
}

/**
 * Get total unseen alert count (for badge).
 */
export function getUnseenAlertCount() {
  const row = stmts.getUnseenCount.get();
  return row ? row.count : 0;
}
