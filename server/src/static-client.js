import express from 'express';
import path from 'path';
import fs from 'fs';
import { __dirname, app } from './app.js';

// ---------- Serve static client files (production / Electron mode) ----------

// An /api address nothing answered is a real "not found". Without this the
// page fallback below answered it with index.html and a 200, so a caller
// asking for data got a web page and failed trying to read it.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl.split('?')[0]}` });
});

const possibleClientPaths = [
  process.env.SERVE_STATIC,
  process.resourcesPath ? path.join(process.resourcesPath, 'client-dist') : null,
  path.join(__dirname, '..', '..', 'client', 'dist'),
  path.join(__dirname, '..', '..', 'client-dist'),
].filter(Boolean);

export let servingStaticClient = false;
for (const clientPath of possibleClientPaths) {
  if (fs.existsSync(clientPath)) {
    // The page and the service worker are the two files that decide which
    // version of the app someone is running, so they are never allowed to come
    // from a cache. Everything else under /assets carries a content hash in its
    // name and can be cached hard. Getting this wrong is invisible and lasts
    // forever: a stale worker served a months-old build for as long as it was
    // installed, which made every front-end change look like it had failed.
    app.use((req, res, next) => {
      if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js' || req.path === '/registerSW.js') {
        res.set('Cache-Control', 'no-store');
      }
      next();
    });
    app.use(express.static(clientPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(clientPath, 'index.html'));
    });
    console.log(`Serving static client from ${clientPath}`);
    servingStaticClient = true;
    break;
  }
}
