// A stand-in for ffmpeg in the TV relay tests. It does the one thing that
// matters to them: read the address after -i the way ffmpeg does (with any
// -headers lines sent along, and redirects followed), and write what arrives
// to standard output. With --hold it then stays open until it is killed, the
// way an encoder does in the middle of a film.

import http from 'http';

const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const hold = args.includes('--hold');
const headerText = args.includes('-headers') ? args[args.indexOf('-headers') + 1] : '';
const headers = Object.fromEntries(
  headerText
    .split('\r\n')
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()])
);

function read(url, hops) {
  http
    .get(url, { headers }, (res) => {
      const { location } = res.headers;
      if (res.statusCode >= 300 && res.statusCode < 400 && location && hops < 5) {
        res.resume();
        return read(new URL(location, url), hops + 1);
      }
      if (res.statusCode >= 400) {
        res.resume();
        // ffmpeg names the address it could not read, ticket and all.
        process.stderr.write(`${url}: Server returned ${res.statusCode}\n`);
        process.exitCode = 1;
        return undefined;
      }
      res.pipe(process.stdout, { end: !hold });
      if (hold) res.on('end', () => setInterval(() => {}, 1000));
      return undefined;
    })
    .on('error', (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
}

read(new URL(input), 0);
