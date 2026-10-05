// Heldover server entry point. Each feature registers its routes on the
// shared Express app when imported; the order below is the order they are
// matched in, with the static client last so it never shadows an /api route.
import './app.js';
import './routes/servers-posters.js';
import './routes/library.js';
import './routes/search.js';
import './routes/monitoring.js';
import './routes/watchlist.js';
import './routes/streaming-stats.js';
import './routes/settings-profiles.js';
import './routes/ask-swipe-shelves.js';
import './routes/tv.js';
import './routes/downloads.js';
import './routes/lists.js';
import './routes/subscriptions.js';
import './background.js';
import './library-loader.js';
import './routes/moods-curated.js';
import './routes/discovery.js';
import './routes/external-lists.js';
import './static-client.js';
import { getOwnerCode, isSetupComplete } from './config.js';
import { initProfiles } from './profiles.js';
import { startMdblistBackfill, startTmdbKeywordBackfill } from './ratings.js';
import { startFanartBackfill } from './fanart.js';
import { getLanIp, publishMdns, printQr, unpublishMdns } from './discovery.js';
import { prune as prunePosters } from './poster-cache.js';
import { warmLibraries } from './library-warmer.js';
import { startRatingsBackfill } from './ratings-backfill.js';
import { servingStaticClient } from './static-client.js';
import { PORT, app, ensureServers } from './app.js';
import { indexExistingCaches } from './routes/settings-profiles.js';
import { bindHost, isLoopbackHost, onDockerBridge, setLanUrls } from './listen-address.js';
import { signStoredPictureAddresses } from './picture-addresses.js';

// ---------- Start ----------

const userFacingPort = servingStaticClient
  ? PORT
  : Number(process.env.CLIENT_PORT) || 3000;
const mdnsName = process.env.MDNS_NAME || 'heldover';
const mdnsDisabled = process.env.DISABLE_MDNS === '1';
// Every network adapter unless BIND_HOST says otherwise. The desktop app
// starts its server on 127.0.0.1 until the owner lets other devices connect.
const BIND_HOST = bindHost();
const thisComputerOnly = isLoopbackHost(BIND_HOST);
const everyAdapter = BIND_HOST === '0.0.0.0' || BIND_HOST === '::';

initProfiles();

// Index whatever is already cached so the shelves work on the first run after
// an update, without waiting for a full library sweep.
setTimeout(() => {
  indexExistingCaches().catch((err) => console.error('Corpus catch-up failed:', err.message));
}, 20 * 1000);

// The poster cache is bounded, checked once at startup and occasionally after,
// so an unattended machine cannot slowly fill its own disk with covers.
prunePosters();
setInterval(prunePosters, 6 * 60 * 60 * 1000).unref();

// Warm the library caches a minute after boot. Delayed so it never competes
// with whatever the user is doing in the first moments after a restart.
setTimeout(() => {
  if (!process.env.PLEX_TOKEN) return;
  warmLibraries(ensureServers, process.env.PLEX_TOKEN).catch((err) =>
    console.error('Initial warm-up failed:', err.message)
  );
}, 60 * 1000);

// Then give every cached title a real rating. Shelves and percent-match can
// only choose from titles the app actually knows something about.
setTimeout(() => {
  if (!process.env.PLEX_TOKEN) return;
  startRatingsBackfill(ensureServers, process.env.PLEX_TOKEN).catch((err) =>
    console.error('Initial ratings backfill failed:', err.message)
  );
}, 5 * 60 * 1000);

// And keep them fresh: stale caches get re-read every six hours.
setInterval(() => {
  if (!process.env.PLEX_TOKEN) return;
  warmLibraries(ensureServers, process.env.PLEX_TOKEN).catch((err) =>
    console.error('Scheduled warm-up failed:', err.message)
  );
}, 6 * 60 * 60 * 1000);

// Anything that throws ends here. The message is plain and the details stay
// in the log: a stack trace names files and folders on this machine.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('Unhandled error:', err.message);
  res.status(status).json({ error: status < 500 ? 'That request could not be read' : 'Something went wrong' });
});

const listener = app.listen(PORT, BIND_HOST, () => {
  // Picture addresses stored before they were signed get their signature
  // here, once (picture-addresses.js). After this an unsigned address is
  // refused, and nothing is signed on the way out of the database.
  //
  // First thing in this callback, and in one go, on purpose. Nothing else
  // runs until it returns, so no request is answered from rows that are not
  // signed yet. And the port is already open, so a device that asks during
  // those seconds (up to half a minute for several hundred thousand titles,
  // an instant for most libraries) waits for its answer instead of being told
  // nothing is there. A failure is said and startup carries on: the cost is
  // posters that stay blank until their library is read again, not a broken
  // app.
  try {
    signStoredPictureAddresses();
  } catch (err) {
    console.error('[pictures] could not sign the stored picture addresses, so some posters will be blank until their library is read again:', err.message);
  }

  console.log(`Heldover server running on http://localhost:${PORT}`);
  // The settings code proves ownership from another device. Printed here
  // because only whoever runs Heldover can read this log.
  console.log('');
  console.log(`Settings code: ${getOwnerCode()}`);
  console.log(
    isSetupComplete()
      ? '  Enter it in Settings on any device you want to manage Heldover from.'
      : '  Setting up from another device? Enter this code on the setup screen.'
  );
  console.log('');
  // A new install has none of these yet and that is normal: the first two are
  // asked for on the setup screen, the rest are extras. "MISSING" read like a
  // fault, and for the optional keys it never was one.
  const optional = (value) => (value ? 'configured' : 'not set (optional)');
  console.log(
    `Plex token: ${process.env.PLEX_TOKEN ? 'configured' : 'not set yet (sign in on the setup screen)'}`
  );
  console.log(
    `TMDB API key: ${process.env.TMDB_API_KEY ? 'configured' : 'not set yet (add it on the setup screen)'}`
  );
  console.log(`OMDb API key: ${optional(process.env.OMDB_API_KEY)}`);
  console.log(`MDBList API key: ${optional(process.env.MDBLIST_API_KEY)}`);
  console.log(`Fanart.tv API key: ${optional(process.env.FANART_API_KEY)}`);
  startMdblistBackfill();
  startTmdbKeywordBackfill();
  startFanartBackfill();

  if (thisComputerOnly) {
    // Nothing else can reach the app, so nothing is announced on the network
    // and there is no address or QR code to hand to a phone.
    console.log('');
    console.log('Open Heldover on this computer (other devices cannot connect):');
    console.log(`  http://localhost:${userFacingPort}`);
    console.log('');
    return;
  }

  if (!everyAdapter) {
    // Listening on one chosen address: that is the only one that answers, so
    // it is the only one printed, and the .local names (which may resolve to
    // a different adapter) are not announced.
    const only = `http://${BIND_HOST.includes(':') ? `[${BIND_HOST}]` : BIND_HOST}:${userFacingPort}`;
    setLanUrls([only]);
    console.log('');
    console.log('Open Heldover at:');
    console.log(`  ${only}`);
    console.log('');
    console.log('Scan to open on your phone:');
    printQr(only);
    return;
  }

  if (onDockerBridge()) {
    // The only address visible in here is the container's own, which nothing
    // outside the Docker host can open, and a .local name announced from
    // inside never reaches the home network. Printing them (with a QR code)
    // sent people to addresses that do not answer.
    console.log('');
    console.log(
      `Heldover is running in a container. Open it at your server's own address and the port you mapped to ${PORT}, for example http://<your server>:${PORT}`
    );
    console.log('');
    return;
  }

  const lanIp = getLanIp();
  let mdns = { host: null, alias: null };
  if (!mdnsDisabled) {
    mdns = publishMdns({ port: userFacingPort, name: mdnsName });
  }

  const urls = [
    // heldover.local first (it is what the QR code encodes): macOS renames
    // the machine itself when it sees a name clash on the network (the number
    // on the end of its name changes), so its own .local name is not a stable
    // bookmark.
    mdns.alias ? `http://${mdns.alias}:${userFacingPort}` : null,
    mdns.host ? `http://${mdns.host}:${userFacingPort}` : null,
    lanIp ? `http://${lanIp}:${userFacingPort}` : null,
    `http://localhost:${userFacingPort}`,
  ].filter(Boolean);
  // What the settings screen lists for other devices: everything but localhost.
  setLanUrls(urls.slice(0, -1));

  console.log('');
  console.log('Open Heldover from any device on your network:');
  for (const url of urls) console.log(`  ${url}`);
  console.log('');

  const primaryUrl = urls[0];
  if (primaryUrl) {
    console.log('Scan to open on your phone:');
    printQr(primaryUrl);
  }
});

// A port already taken, or a BIND_HOST this computer does not have, used to
// end in a stack trace. Say what is wrong and what to change instead.
listener.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use, perhaps by another copy of Heldover. Close it, or set PORT to a different number.`);
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(`BIND_HOST=${BIND_HOST} is not an address of this computer. Remove it to listen on every adapter, or use 127.0.0.1 for this computer only.`);
  } else {
    console.error(`Heldover could not start listening: ${err.message}`);
  }
  process.exit(1);
});

async function shutdown() {
  await unpublishMdns();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
