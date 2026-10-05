import os from 'os';
import { Bonjour } from 'bonjour-service';
import qrcode from 'qrcode-terminal';

export function getLanIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }
  if (candidates.length === 0) return null;

  // Rank adapters so a phone-reachable LAN IP wins over virtual/overlay ones.
  const score = ({ name, address }) => {
    const n = name.toLowerCase();
    // WSL / Hyper-V virtual switches — unreachable from a phone
    if (n.includes('vethernet') || n.includes('wsl') || n.includes('hyper-v') || n.includes('default switch')) return 0;
    // Tailscale / CGNAT overlay (100.64.0.0/10) — only reachable on the tailnet
    if (n.includes('tailscale') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 1;
    // Real home/office LAN ranges
    if (address.startsWith('192.168.')) return 100;
    if (address.startsWith('10.')) return 90;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 80;
    return 50;
  };

  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0].address;
}

let bonjour = null;
let service = null;

/**
 * Advertise the app on the local network, and report an address that a phone
 * can actually open.
 *
 * The distinction that was got wrong here: publishing a *service* called
 * "heldover" makes it findable in a Bonjour service browser, but it does not
 * create a machine called heldover.local. This returned that name anyway, so
 * the startup banner, and the QR code printed under "Scan to open on your
 * phone", both pointed at an address that has never resolved on any device.
 *
 * The machine's own Bonjour name does resolve, and unlike the IP address it
 * survives the router handing out a different one, so that is what gets
 * reported. The service is still published for anything that browses for it.
 *
 * The service now also carries its own host name, `<name>.local`, and answers
 * for it, so heldover.local does resolve (from this app, not the Mac). Both
 * addresses are printed, heldover.local first: the machine's own name
 * changes whenever macOS sees a clash on the network.
 *
 * probe is off: after a restart the network still remembers the previous run's
 * announcement for a while, and the probe mistook that ghost of ourselves for
 * another device, logged "Service name is already in use", and published
 * nothing at all.
 */
export function publishMdns({ port, name = 'heldover' }) {
  let host = null;
  try {
    // os.hostname() is already the ".local" name on macOS; elsewhere it may be
    // a bare name, so the suffix is only added when it is missing.
    const raw = os.hostname();
    if (raw && raw !== 'localhost') {
      host = raw.endsWith('.local') ? raw : `${raw}.local`;
    }
  } catch {
    host = null;
  }

  try {
    bonjour = new Bonjour();
    service = bonjour.publish({
      name,
      type: 'http',
      port,
      host: `${name}.local`,
      probe: false,
      // IPv4 only. With IPv6 on, the name also resolved to fe80:: link-local
      // addresses, which carry no usable interface for other devices; Chrome
      // tried those and showed an error page even though IPv4 worked.
      disableIPv6: true,
      txt: { path: '/' },
    });
  } catch (err) {
    console.warn('mDNS publish failed:', err.message);
  }

  if (service) answerOneShotQueries(`${name}.local`);
  return { host, alias: service ? `${name}.local` : null };
}

/**
 * Answer "one-shot" lookups for the alias directly.
 *
 * Android (12 and later) looks up .local names by sending a single query from
 * a random port and listening only on that port for the reply (RFC 6762 5.1).
 * bonjour-service only ever answers to the whole network on port 5353, which
 * iPhones and Macs hear but Android never does: heldover.local failed on
 * an Android phone while the IP address worked. The standard says such a
 * query gets a direct reply with its id and question echoed and a TTL of at
 * most 10 seconds, which is what this sends.
 */
function answerOneShotQueries(alias) {
  const mdns = bonjour?.server?.mdns;
  if (!mdns) return;
  const wanted = alias.toLowerCase();
  mdns.on('query', (query, rinfo) => {
    if (!rinfo || rinfo.port === 5353) return;
    // Echo the question as plain IN: it arrives with the "reply to me" bit
    // set (class 0x8001), and echoing that back made the reply unusable.
    const questions = (query.questions || [])
      .filter((q) => String(q.name).toLowerCase() === wanted && (q.type === 'A' || q.type === 'ANY'))
      .map((q) => ({ name: q.name, type: q.type, class: 'IN' }));
    const ip = getLanIp();
    if (questions.length === 0 || !ip) return;
    mdns.respond(
      { id: query.id, questions, answers: [{ name: alias, type: 'A', ttl: 10, data: ip }] },
      { address: rinfo.address, port: rinfo.port },
      () => {}
    );
  });
}

/**
 * Withdraw the announcement and wait (briefly) for the goodbye to go out.
 * Exiting straight after stop() dropped it, which is what left the ghost
 * announcement behind for the next start to trip over.
 */
export function unpublishMdns() {
  return new Promise((resolve) => {
    const done = () => {
      try {
        if (bonjour) bonjour.destroy();
      } catch {
        // best-effort
      }
      service = null;
      bonjour = null;
      resolve();
    };
    if (!bonjour) return resolve();
    const timer = setTimeout(done, 1000);
    try {
      bonjour.unpublishAll(() => {
        clearTimeout(timer);
        done();
      });
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

export function printQr(url) {
  qrcode.generate(url, { small: true });
}
