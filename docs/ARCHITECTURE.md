# How Heldover fits together

One Node process serves both the API and the built web app. Phones, the desktop wrapper and browsers all talk to it over the home network. It keeps everything it learns in one SQLite database and a poster cache in the data folder.

```
 phones / browsers / Electron window
            │  same-origin HTTP (PIN cookie when a PIN is set)
            ▼
 ┌──────────────────────── server (Express, Node 22+) ────────────────────────┐
 │ app.js           middleware, owner/PIN gates, shared server list            │
 │ routes/*.js      one file per feature, registered in the order index.js     │
 │                  imports them; static-client.js last                        │
 │ background.js    health check (5 min, shared with Re-check), new-additions  │
 │                  scan (6 h, keeps 30 days), episode check (1 h), old-row    │
 │                  cleanup 3 min after start                                  │
 │ library-warmer   reads every library in the background into corpus_index   │
 │ ratings-*        OMDb / MDBList / TMDB lookups, cached in ratings_cache     │
 └────────────┬──────────────────────┬──────────────────────┬─────────────────┘
              │                      │                      │
   plex.tv + Plex servers     TMDB, OMDb, MDBList,     TVs on the LAN (DLNA),
   (yours and shared ones)    Fanart.tv                 ffmpeg relay when needed
```

## Server (`server/src`)

| Area | Files | Notes |
|---|---|---|
| Startup | `index.js`, `env-check.js`, `config.js` | `env-check` validates environment variables before anything reads them; `config.js` copies settings saved in the app into the environment. |
| Shared app | `app.js` | The Express app, request guards, `ensureServers()` (cached server list, one discovery at a time), `getPlexToken()`. |
| Routes | `routes/*.js` | Library and search, TV casting, downloads, swipe, lists, subscriptions, discovery. The order of imports in `index.js` is the order routes match. |
| Plex | `plex.js` → `plex-connections`, `plex-servers`, `plex-library`, `plex-playback`, `plex-images` | `plex.js` only re-exports. Shared servers plex.tv has not seen for 30 days are skipped. |
| Ratings | `ratings.js` → `ratings-store`, `ratings-mdblist`, `ratings-omdb`, `ratings-tmdb`, `ratings-lookup` | `ratings.js` only re-exports. Daily API limits are counted in `api_usage`. |
| Search index | `corpus-index.js`, `library-warmer.js` | About 480k titles in SQLite, not memory. |
| Plex requests | `plex-fetch.js` | `plexFetch` and `sameOriginUrl`: every request to a Plex server or player stays on the address it was sent to, and the token travels as a header. |
| Casting | `tv.js`, `routes/tv.js` | UPnP discovery (bounded), play/pause, ffmpeg relay for files the TV cannot play. Devices other than the owner can cast only to TVs in `approvedTvs`. ffmpeg reads with a fixed input format taken from the container Plex reports, and may use http to this computer only. |

Every call to an outside service has a time limit (10 to 30 seconds), except the download and relay streams, which run as long as the file does. A request to a Plex server has one time limit that covers the whole answer: 120 seconds for a library page, 15 for a server's list of sections, 8 for who is playing. Every answer read into memory is limited to 64 MB (8 MB for small ones); a file streamed to a download or the TV is not.

## Client (`client/src`)

React + Vite + Tailwind, installed as a PWA.

- `main.jsx` decides what a device sees first (PIN, setup, or the app) and mounts the `ErrorBoundary` and `NoticeHost`.
- `App.jsx` holds the page state. Filter rules live in `lib/library-filters.js`, and "where you were" in `lib/session.js`.
- `lib/notice.js` provides `reportProblem()`. Use it in any catch that follows a user action, so a failure shows on screen instead of only in the console.

## Things that bite

- `/api/libraries` takes 4 to 6 seconds, because it asks every remote server. Any cache or timeout shorter than that serves stale or empty data.
- The service worker must never cache the app shell (`navigateFallback: null`). A cached shell once served a months-old build indefinitely.
- A section or item number that comes from a request must pass `isListedLibrary` or `isListedItem` (`plex-library.js`) before the stored copy or Plex is read. The app lists only movie and show libraries; a Plex server holds more.
- A poster address is only served when the app issued it: build every one with `proxiedImageUrl` (`plex-images.js`), which signs it. A `thumb` sent by a browser is never signed.
- Use `plexFetch` for anything addressed to a Plex server or player, never a bare `fetch`: a server shared with you can answer with a redirect.
- `getLibraryItems` shares one read per library and runs two at most. Do not wrap it in a second cache or call Plex for a whole library any other way.
- Plex rating keys are only unique per server. Key anything per-title by `ratingKey|title|year` or `server:ratingKey`.
- The memory the server needs grows with the number of libraries it can reach. A limit that suits a handful (512 MB) made it crash and restart in a loop once it held a few dozen. If you cap it, leave room: for example `node --max-old-space-size=4096 src/index.js` for a 4 GB heap.
