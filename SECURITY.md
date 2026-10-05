# Security

Heldover handles Plex sign-in tokens, including tokens for servers other people share with you, so security reports are very welcome.

## Reporting a problem

Please report security issues privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for security problems.

Include what you found, how to reproduce it, and what an attacker could do with it. You should get a reply within a week.

## What is in scope

- Anything that exposes a Plex token or API key outside the machine running Heldover
- Ways around the access PIN, the look-only rule or the owner-only settings
- Ways for a web page or another device to act on the app without the owner's consent

## Design notes

- Tokens and keys are stored in `DATA_DIR/config.json`, readable only by the user running Heldover, and never sent to browsers.
- Without a PIN, other devices on the network are look-only. Anything that changes something (rate, hide, queue, swipe, cast, download) needs the PIN, when one is set, or the settings code. Settings always need the owner.
- A Plex token is sent to a Plex server only over `https`, as a header, and a request to a Plex server is never followed to another machine. Plain `http` is an owner opt-in (`PLEX_ALLOW_HTTP=1`).
- Only the movie and show libraries the app lists can be read, downloaded, cast or followed. A poster is served only from an address the app itself issued and signed.
- Devices other than the owner can cast only to TVs the owner has approved, and a link handed to a TV works only from that TV. The link stops working when the owner removes that TV, when the TV refuses the cast, or when the film is stopped from the app.
- The app sets its own limits on what a Plex server or a look-only device can make it do: a time limit that covers a whole answer, a size limit on every answer read into memory (a poster is read only up to 8 MiB, counted as it arrives), a ceiling on the titles read from one library, a length limit on search and ask text, and a minimum interval between forced re-reads of the server list and between server re-checks.
- When plex.tv stops naming a server, the app removes its stored libraries and its list of libraries.
- The app is built for a home network. Exposing it directly to the internet is not supported; use a VPN.
