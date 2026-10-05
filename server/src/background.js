import { checkAllServersShared, removeOldSnapshots, scanForNewAdditions } from './monitor.js';
import { checkForNewEpisodes } from './subscriptions.js';
import { cachedServers } from './app.js';

// ---------- Background Intervals ----------

/**
 * Server health check — every 5 minutes.
 */
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const serversKnownOffline = new Set();

async function runHealthCheck() {
  try {
    const token = process.env.PLEX_TOKEN;
    if (!token || !cachedServers) return;

    // Shared with the re-check route: a request that arrives while this
    // round runs joins it instead of probing every server a second time.
    const results = await checkAllServersShared(() => cachedServers, token);

    // Log changes, not state. A server that stayed down for a month used to
    // write the same line every five minutes, thousands of times, burying
    // everything else in the log.
    const ts = new Date().toISOString();
    for (const s of results) {
      const wasOffline = serversKnownOffline.has(s.serverKey);
      if (!s.online && !wasOffline) {
        serversKnownOffline.add(s.serverKey);
        console.warn(`[${ts}] Server offline: ${s.serverName} (${s.serverUri})`);
      } else if (s.online && wasOffline) {
        serversKnownOffline.delete(s.serverKey);
        console.log(`[${ts}] Server back online: ${s.serverName}`);
      }
    }
  } catch (err) {
    console.error('Background health check error:', err.message);
  }
}
setInterval(() => void runHealthCheck(), HEALTH_CHECK_INTERVAL_MS);

/**
 * New additions scan — every 6 hours.
 */
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function runNewAdditionsScan() {
  try {
    const token = process.env.PLEX_TOKEN;
    if (!token || !cachedServers) return;

    const newItems = await scanForNewAdditions(cachedServers, token);
    console.log(
      `[${new Date().toISOString()}] New additions scan: ${newItems.length} items found in last 7 days`
    );

    // Also check for new episodes during the full scan
    try {
      const episodeResults = await checkForNewEpisodes(cachedServers, token);
      if (episodeResults.length > 0) {
        console.log(
          `[${new Date().toISOString()}] Episode check (full scan): ${episodeResults.length} shows with new episodes`
        );
      }
    } catch (epErr) {
      console.error('Episode check during scan error:', epErr.message);
    }
  } catch (err) {
    console.error('Background scan error:', err.message);
  }
}
setInterval(() => void runNewAdditionsScan(), SCAN_INTERVAL_MS);

/**
 * New-additions rows that are too old to show are dropped a few minutes after
 * start as well as in every scan. The scan first runs six hours after start,
 * and a copy that is restarted more often than that would never reach it.
 * The first run after an update may have several hundred thousand rows to
 * drop, so it waits until the app has finished starting.
 */
const OLD_ROWS_CLEANUP_DELAY_MS = 3 * 60 * 1000;

setTimeout(() => {
  removeOldSnapshots()
    .then((removed) => {
      if (removed > 0) console.log(`[new additions] removed ${removed} rows too old to show`);
    })
    .catch((err) => console.error('New additions cleanup error:', err.message));
}, OLD_ROWS_CLEANUP_DELAY_MS);

/**
 * Episode check — every 1 hour (more frequent than the full scan).
 */
const EPISODE_CHECK_INTERVAL_MS = 1 * 60 * 60 * 1000;

async function runEpisodeCheck() {
  try {
    const token = process.env.PLEX_TOKEN;
    if (!token || !cachedServers) return;

    const results = await checkForNewEpisodes(cachedServers, token);
    if (results.length > 0) {
      console.log(
        `[${new Date().toISOString()}] Episode check: ${results.length} shows with new episodes`
      );
      for (const r of results) {
        console.log(`  - "${r.title}": ${r.newCount} new episode(s)`);
      }
    }
  } catch (err) {
    console.error('Background episode check error:', err.message);
  }
}
setInterval(() => void runEpisodeCheck(), EPISODE_CHECK_INTERVAL_MS);
