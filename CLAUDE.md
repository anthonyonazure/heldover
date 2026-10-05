# Heldover

Find something to watch across every Plex server an account can reach. It covers the account's own servers and shared ones. Node/Express + SQLite server, React client, Electron wrapper. Layout and data flow: `docs/ARCHITECTURE.md`.

## Commands

- `cd server && npm test`: core tests under Node (`server/test`). `bun test` runs the pure tests in `server/src`. Bun cannot load better-sqlite3.
- `bun run check`: typecheck + lint for the whole repo.
- `cd client && npx vite build`: the server serves `client/dist`.

## Gotchas

- If a live install runs from a working tree, changes there go live the next time it restarts.
- A second copy started with the default `MDNS_NAME` sends a goodbye for `heldover.local` when it stops and knocks the first copy's name off phones. Test copies set `DISABLE_MDNS=1` or their own `MDNS_NAME`.
- Route order is import order in `server/src/index.js`. `static-client.js` must stay last.
- `plex.js` and `ratings.js` are re-export facades. Put new code in the concern file, not the facade.
- Never run `npm run rebuild:server` in `electron/` against a server folder a live app uses. It recompiles the database driver for Electron.
- `/api/libraries` legitimately takes 4 to 6 seconds, so keep timeouts and caches longer than that.
- Plex rating keys are unique only per server.
- In the client, a catch after a user action calls `reportProblem()` (`lib/notice.js`), not `console.error` alone.
- The public repository is built with `scripts/make-public-tree.sh` (an allowlist: committed files only, minus what `.gitattributes` marks `export-ignore`), never by copying a folder. A working folder also holds ignored files with secrets. The script itself stays out of the public copy.
