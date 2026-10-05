// Which network address the server listens on, and what it tells people about
// reaching it from other devices.
//
// Listening on every interface (0.0.0.0) is what lets a phone on the Wi-Fi
// open the app, and it is the default for Docker and run-from-source installs,
// where that is the point. The desktop app starts closed instead (127.0.0.1,
// this computer only) until its owner turns on "let phones connect": nobody
// installing a desktop app expects it to open a port to the whole network.
//
// Kept free of the database and config so it can be tested on its own.

import fs from 'fs';
import os from 'os';

/** The address to listen on. env-check.js has already stopped startup for one it cannot use. */
export function bindHost() {
  return process.env.BIND_HOST || '0.0.0.0';
}

/** True for an address only this computer can reach. */
export function isLoopbackHost(host) {
  return host === '::1' || /^127\./.test(String(host || ''));
}

/** True when the Electron app started this server (it sets this itself). */
export function isDesktop() {
  return process.env.PLEX_PICKER_DESKTOP === '1';
}

/** Every IPv4 address of this machine that is not loopback, with its adapter. */
export function externalIpv4() {
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const iface of addresses || []) {
      if (iface.family === 'IPv4' && !iface.internal) found.push({ name, address: iface.address });
    }
  }
  return found;
}

// The private range Docker hands out to its bridge networks (172.17.0.0/16
// for the default one, the next ones up for networks made by compose).
const DOCKER_BRIDGE_RANGE = /^172\.(1[6-9]|2\d|3[01])\./;

/**
 * True inside a container on one of Docker's bridge networks, where the only
 * addresses the app can see are the container's own. Nothing outside the
 * Docker host can open those, so printing them (and a QR code for them) sends
 * people to an address that never answers.
 *
 * With host networking the container sees the host's adapters instead, and
 * Docker's own bridge (docker0, br-...) shows up among them. That is how a
 * home network that itself uses 172.16 to 172.31 is told apart from a bridge.
 *
 * @param {{ inContainer: boolean, interfaces: { name: string, address: string }[] }} seen
 */
export function onDockerBridge({ inContainer = fs.existsSync('/.dockerenv'), interfaces = externalIpv4() } = {}) {
  if (!inContainer || interfaces.length === 0) return false;
  if (interfaces.some(({ name }) => /^(docker\d|br-)/.test(name))) return false;
  return interfaces.every(({ address }) => DOCKER_BRIDGE_RANGE.test(address));
}

// The addresses other devices can open, as printed at startup. index.js fills
// this in once the server is listening; the settings screen shows the same list.
let lanUrls = [];

export function setLanUrls(urls) {
  lanUrls = [...urls];
}

export function getLanUrls() {
  return [...lanUrls];
}
