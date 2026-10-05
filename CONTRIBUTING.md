# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Run it

You need [Node.js 22 or newer](https://nodejs.org). ffmpeg is optional (it is only used when casting a file the TV cannot play).

```bash
cd server && npm install && npm run dev      # API on :3001, restarts on change
cd client && npm install && npm run dev      # UI on :3000, proxies /api to :3001
```

Open `http://localhost:3000` and sign in on the setup screen. Settings, the database and posters are kept in `server/data`, which git ignores.

If another copy of Heldover already runs on your network, start your test copy with `DISABLE_MDNS=1` (or its own `MDNS_NAME`), a different `PORT` and its own `DATA_DIR`. Two copies announcing the same `heldover.local` name knock each other off phones.

How the pieces fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Before you open a pull request

Run these and make sure they pass:

```bash
cd server && npm test            # server tests (Node's test runner)
bun test                         # pure tests in server/src (from the root)
bun run check                    # typecheck and style check (from the root)
cd client && npx vite build      # the client still builds
```

The root checks use [bun](https://bun.sh). Install their tools once with `npm install --ignore-scripts` at the root (without `--ignore-scripts` it also installs the three sub-projects, Electron included).

A few habits this project keeps:

- New behavior comes with a test where one is practical.
- Comments say why, in plain words.
- Text people see in the app is short and plain, and says what to do next.
- One pull request per change, with a description of what it does and how you checked it.

## Security problems

Do not open a public issue for a security problem. Report it privately as described in [SECURITY.md](SECURITY.md).
