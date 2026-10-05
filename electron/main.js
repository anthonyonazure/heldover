const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    windowBounds: { width: 1400, height: 900 },
    minimizeToTray: true,
  },
});

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverPort = 39847;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isPackaged() {
  return app.isPackaged;
}

function getServerPath() {
  if (isPackaged()) {
    return path.join(process.resourcesPath, 'server');
  }
  return path.join(__dirname, '..', 'server');
}

function getClientDistPath() {
  if (isPackaged()) {
    return path.join(process.resourcesPath, 'client-dist');
  }
  return path.join(__dirname, '..', 'client', 'dist');
}

function getEnvPath() {
  return path.join(app.getPath('userData'), '.env');
}

function getServerDataPath() {
  return path.join(app.getPath('userData'), 'data');
}

/**
 * The owner's "let phones and other devices connect" choice, which the server
 * keeps in its own settings file. Read here because the listen address has to
 * be chosen before the server starts. No file yet (first run) means off.
 */
function lanAccessEnabled() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(getServerDataPath(), 'config.json'), 'utf8'));
    return saved.lanAccess === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Environment / First-run
// ---------------------------------------------------------------------------

function initializeEnv() {
  const envPath = getEnvPath();
  if (fs.existsSync(envPath)) return;

  // Try to copy from server dir (developer convenience)
  const serverEnv = path.join(getServerPath(), '.env');
  if (fs.existsSync(serverEnv)) {
    fs.copyFileSync(serverEnv, envPath);
    return;
  }

  // Otherwise create from template
  const template = [
    'PLEX_TOKEN=',
    'TMDB_API_KEY=',
    'OMDB_API_KEY=',
    'OMDB_DAILY_LIMIT=950',
    'GOPEED_URL=http://localhost:9999',
    `PORT=${serverPort}`,
  ].join('\n');
  fs.writeFileSync(envPath, template, 'utf-8');
}

function parseEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip inline comments
    const commentIdx = value.indexOf('#');
    if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
    env[key] = value;
  }
  return env;
}


// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

function startServer() {
  return new Promise((resolve, reject) => {
    if (serverProcess) {
      resolve(serverPort);
      return;
    }

    const serverPath = getServerPath();
    const entryPoint = path.join(serverPath, 'src', 'index.js');

    if (!fs.existsSync(entryPoint)) {
      reject(new Error(`Server entry not found: ${entryPoint}`));
      return;
    }

    // Build environment for the child process
    const envVars = parseEnvFile(getEnvPath());
    envVars.PORT = String(serverPort);
    // Production mode keeps Express from putting stack traces in error replies.
    envVars.NODE_ENV = 'production';

    // Point data directory to userData so packaged app has a writable location
    const dataDir = getServerDataPath();
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    envVars.DATA_DIR = dataDir;

    // Tell server where to find static client files
    const clientDist = getClientDistPath();
    if (fs.existsSync(clientDist)) {
      envVars.SERVE_STATIC = clientDist;
    }

    // Tells the server it runs inside the desktop app: the "let phones
    // connect" switch appears in Settings, and changing it asks us to restart.
    envVars.PLEX_PICKER_DESKTOP = '1';
    // Installing a desktop app should not open a port to everyone on the
    // Wi-Fi. Until the owner turns that switch on, the server listens on this
    // computer only and announces nothing on the network. Decided on every
    // start, so a restart picks up a change to the switch.
    if (lanAccessEnabled()) {
      envVars.BIND_HOST = '0.0.0.0';
    } else {
      envVars.BIND_HOST = '127.0.0.1';
      envVars.DISABLE_MDNS = '1';
    }

    const env = { ...process.env, ...envVars };

    const proc = fork(entryPoint, [], {
      cwd: serverPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    serverProcess = proc;

    // The server asks for a restart when the owner changes the switch above.
    proc.on('message', (message) => {
      if (message && message.type === 'restart-server') void restartAndReload();
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // Assume server started even if we didn't see the log line
        resolve(serverPort);
      }
    }, 8000);

    proc.stdout.on('data', (data) => {
      const msg = data.toString();
      console.log('[server]', msg.trim());
      if (!resolved && msg.includes('running on')) {
        // Parse port from "running on http://localhost:XXXX"
        const match = msg.match(/localhost:(\d+)/);
        if (match) serverPort = parseInt(match[1], 10);
        resolved = true;
        clearTimeout(timeout);
        resolve(serverPort);
      }
    });

    proc.stderr.on('data', (data) => {
      console.error('[server:err]', data.toString().trim());
    });

    // Only forget the server if it is still this one. A late exit from an old
    // process used to clear the variable after a restart, and the app then
    // lost track of the new server and left it running after quitting.
    proc.on('exit', (code) => {
      console.log(`[server] exited with code ${code}`);
      if (serverProcess === proc) serverProcess = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      console.error('[server] error:', err);
      if (serverProcess === proc) serverProcess = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

/**
 * Asks the server to stop and resolves once it has really gone, so the port
 * is free before anything starts another one. A server that ignores the
 * request for five seconds is stopped the hard way.
 */
function stopServer() {
  const proc = serverProcess;
  serverProcess = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function restartServer() {
  await stopServer();
  return startServer();
}

// One restart at a time: a second request while one is under way joins it.
let restarting = null;

/** Restart the server (it re-reads its settings) and show the app again. */
function restartAndReload() {
  if (!restarting) {
    restarting = (async () => {
      try {
        const port = await restartServer();
        if (mainWindow) void mainWindow.loadURL(`http://localhost:${port}`);
      } catch (err) {
        dialog.showErrorBox('Server Error', `Failed to restart server: ${err.message}`);
      } finally {
        restarting = null;
      }
    })();
  }
  return restarting;
}

// ---------------------------------------------------------------------------
// Setup wizard window
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

/** True for the app's own pages, which are the only thing the window shows. */
function isAppUrl(url) {
  try {
    return new URL(url).origin === `http://localhost:${serverPort}`;
  } catch {
    return false;
  }
}

/**
 * Hands a web link to the system browser. Only plain http and https: anything
 * else (file:, a custom app scheme, text that is not an address at all) would
 * ask the operating system to open or run something on the page's say-so.
 */
function openInBrowser(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return;
  }
  if (target.protocol === 'http:' || target.protocol === 'https:') {
    void shell.openExternal(target.href);
  }
}

function createMainWindow(port) {
  const { width, height, x, y } = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 800,
    minHeight: 600,
    title: 'Heldover',
    autoHideMenuBar: true,
    // Use hidden title bar on macOS for a cleaner look
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    backgroundColor: '#0f0f0f',
    // The window shows a web page and nothing more: no Node, no preload
    // script, no bridge into this process. Everything the page can do, it does
    // through the server's API like any phone or browser.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  void mainWindow.loadURL(`http://localhost:${port}`);

  // Save window position/size on move or resize
  const saveBounds = () => {
    if (mainWindow && !mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // The window only ever shows the app's own pages. A link to anywhere else
  // opens in the system browser, and the app stays where it was: a page from
  // another site must never end up running inside this window.
  const keepInApp = (event, legacyUrl) => {
    if (event.isMainFrame === false) return; // trailers and other embedded frames
    const url = event.url || legacyUrl;
    if (isAppUrl(url)) return;
    event.preventDefault();
    openInBrowser(url);
  };
  mainWindow.webContents.on('will-navigate', keepInApp);
  mainWindow.webContents.on('will-redirect', keepInApp);

  // Links that ask for a new window never get one here.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });

  // Minimize to tray instead of closing (if enabled)
  mainWindow.on('close', (event) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function createTray() {
  // Use a small default icon. Replace with a proper icon file for production.
  // Place tray-icon.png (16x16 or 22x22) in the electron/ directory.
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    // Create a tiny 16x16 transparent icon as fallback
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Heldover');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      // Settings live in the app window (the gear icon), shared with every
      // other way of running Heldover.
      label: 'Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Restart Server',
      click: () => void restartAndReload(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

void app.whenReady().then(async () => {
  // Ensure .env exists (copy or create template)
  initializeEnv();

  // First-run setup (Plex sign-in, keys, PIN) happens on the app's own page,
  // the same one Docker and source installs use, so there is one setup to
  // maintain rather than a desktop-only wizard that could drift from it.

  // Start the Express server
  let port;
  try {
    port = await startServer();
  } catch (err) {
    dialog.showErrorBox(
      'Server Error',
      `Failed to start the Heldover server:\n\n${err.message}\n\nMake sure the server files are intact.`
    );
    app.quit();
    return;
  }

  createMainWindow(port);
  createTray();
});

app.on('activate', () => {
  // macOS: re-create window when dock icon is clicked
  if (!mainWindow) {
    createMainWindow(serverPort);
  } else {
    mainWindow.show();
  }
});

app.on('window-all-closed', () => {
  // On macOS keep the app running in the tray
  if (process.platform !== 'darwin' && !store.get('minimizeToTray')) {
    isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  void stopServer();
});
