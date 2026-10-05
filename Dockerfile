# syntax=docker/dockerfile:1

# Heldover: Express server + React client in one image.
# The server serves the built client itself, so there is one port and one process.

ARG NODE_VERSION=22

# ---------- Stage 1: build the React client ----------
FROM node:${NODE_VERSION}-bookworm-slim AS client-build
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---------- Stage 2: server production dependencies ----------
# better-sqlite3 is a native module. A prebuilt binary is used when one exists
# for this Node version and CPU; the toolchain is here for when it has to compile.
FROM node:${NODE_VERSION}-bookworm-slim AS server-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- Stage 3: runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim

LABEL org.opencontainers.image.title="Heldover" \
      org.opencontainers.image.description="Now showing: tonight's pick. Find something to watch across every Plex library you can reach." \
      org.opencontainers.image.licenses="MIT AND GPL-2.0-or-later"

# ffmpeg powers the TV relay (re-encodes audio the TV cannot play). It is
# Debian's build, under its own license (GPL), which is why the license label
# above names both. Heldover itself is MIT.
# tini reaps ffmpeg child processes and forwards stop signals to node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data \
    FFMPEG_PATH=/usr/bin/ffmpeg

WORKDIR /app
# Layout matters: the server looks for the client at ../../client/dist relative
# to server/src, which resolves to /app/client/dist here.
COPY --chown=node:node server/package.json server/package-lock.json ./server/
COPY --chown=node:node --from=server-deps /build/server/node_modules ./server/node_modules
COPY --chown=node:node server/src ./server/src
COPY --chown=node:node --from=client-build /build/client/dist ./client/dist

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# No USER line, on purpose. The container starts as root only long enough for
# the entrypoint to make /data writable (Docker creates a missing bind-mount
# folder owned by root), then the app runs as PUID:PGID, 1000:1000 unless set.
# Started with "user:" or "--user", it skips that step and runs as given.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

WORKDIR /app/server
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health/memory').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
