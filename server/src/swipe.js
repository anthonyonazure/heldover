// Couples swipe.
//
// The failure mode this exists for is not "we cannot find anything to watch",
// it is "neither of us wants to be the one who chose". Both people swipe
// through the same deck on their own phones and the app names the first title
// they both said yes to, so the decision has no author.
//
// The deck is fixed when the session starts. If each person got their own
// shuffle you would be comparing votes on different films, and a match would
// only happen by luck.

import crypto from 'crypto';
import { openRatingsDb } from './db.js';

const db = openRatingsDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS swipe_sessions (
    code TEXT PRIMARY KEY,
    deck TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// When one phone deals another round, the old session points at the new one,
// so the other phone can follow instead of swiping a deck nobody else sees.
const sessionCols = new Set(db.prepare('PRAGMA table_info(swipe_sessions)').all().map((c) => c.name));
if (!sessionCols.has('next_code')) db.exec('ALTER TABLE swipe_sessions ADD COLUMN next_code TEXT');

// Votes are filed by device and by card.
//
// By device, not by profile: both phones default to the first profile, and
// keyed by profile the second person's votes simply replaced the first
// person's, so the app saw one voter and could never report a match.
//
// By card, meaning server and rating key together: rating keys are only unique
// within one server, so two different films in one deck could share a number
// and a yes to one counted as a yes to the other.
//
// This replaces the older swipe_votes table, which is no longer read.
db.exec(`
  CREATE TABLE IF NOT EXISTS swipe_ballots (
    code TEXT NOT NULL,
    voter TEXT NOT NULL,
    card_key TEXT NOT NULL,
    vote TEXT NOT NULL CHECK(vote IN ('yes', 'no')),
    voted_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (code, voter, card_key)
  )
`);

const insertSession = db.prepare('INSERT INTO swipe_sessions (code, deck) VALUES (?, ?)');
const selectSession = db.prepare('SELECT * FROM swipe_sessions WHERE code = ?');
const setNextCode = db.prepare('UPDATE swipe_sessions SET next_code = ? WHERE code = ?');
const upsertVote = db.prepare(`
  INSERT INTO swipe_ballots (code, voter, card_key, vote, voted_at)
  VALUES (@code, @voter, @card_key, @vote, datetime('now'))
  ON CONFLICT(code, voter, card_key) DO UPDATE SET vote = excluded.vote, voted_at = datetime('now')
`);
const selectVotes = db.prepare('SELECT * FROM swipe_ballots WHERE code = ?');
const selectMyVotes = db.prepare('SELECT card_key, vote FROM swipe_ballots WHERE code = ? AND voter = ?');
// Votes go with their session. Left behind, a reused code inherited the old
// round's votes and could announce a match before anyone had swiped.
const deleteOldSessions = db.transaction(() => {
  db.prepare("DELETE FROM swipe_sessions WHERE created_at < datetime('now', '-2 days')").run();
  db.prepare('DELETE FROM swipe_ballots WHERE code NOT IN (SELECT code FROM swipe_sessions)').run();
});
const deleteVotesFor = db.prepare('DELETE FROM swipe_ballots WHERE code = ?');

// Unambiguous when read aloud across a room: no O/0, no I/1.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The identity of one card in a deck: its server and its rating key. */
export function cardKeyFor(card) {
  return `${card.serverKey}:${card.ratingKey}`;
}

function parseDeck(row) {
  let deck;
  try {
    deck = JSON.parse(row.deck);
  } catch {
    deck = [];
  }
  // Decks dealt before cards carried their own key get one on the way out.
  return deck.map((card) => ({ ...card, cardKey: card.cardKey || cardKeyFor(card) }));
}

/** Only a short opaque token from the device; anything else is refused. */
export function validVoter(voter) {
  return typeof voter === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(voter);
}

/**
 * Build a deck and open a session.
 * @param {Array} pool - candidate titles, already rated and deduped
 * @param {number} size - how many cards to deal
 * @param {string} [previousCode] - the round this one follows, if any
 */
export function createSession(pool, size = 40, previousCode = null) {
  deleteOldSessions();

  // Take from the top of the pool rather than the whole library, then shuffle.
  // A deck drawn uniformly from 300,000 titles is mostly things neither person
  // has heard of, and swiping no forty times is not a game anyone enjoys.
  const candidates = pool.slice(0, Math.max(size * 6, 200));
  const deck = shuffle(candidates)
    .slice(0, size)
    .map((item) => {
      const card = {
        ratingKey: String(item.ratingKey),
        serverKey: item.serverKey,
        title: item.title,
        year: item.year || null,
        type: item.type || 'movie',
        thumb: item.thumb || null,
        summary: item.summary || null,
        genres: item.genres || [],
        duration: item.duration || null,
        imdbRating: item.imdbRating ?? null,
        tmdbId: item.tmdbId ?? null,
      };
      return { ...card, cardKey: cardKeyFor(card) };
    });

  // About a million codes and a handful live at once, so a clash is rare, but
  // a clash that is not retried is a failed "start" button.
  let code = makeCode();
  for (let attempt = 0; attempt < 50 && selectSession.get(code); attempt++) {
    code = makeCode();
  }
  if (selectSession.get(code)) throw new Error('Could not find a free session code, try again');

  deleteVotesFor.run(code);
  insertSession.run(code, JSON.stringify(deck));

  const previous = previousCode ? selectSession.get(String(previousCode).toUpperCase()) : null;
  if (previous) setNextCode.run(code, previous.code);

  return { code, deck };
}

export function getSession(code, voter = null) {
  const row = selectSession.get(String(code).toUpperCase());
  if (!row) return null;

  const mine = validVoter(voter)
    ? Object.fromEntries(selectMyVotes.all(row.code, voter).map((v) => [v.card_key, v.vote]))
    : {};

  return { code: row.code, deck: parseDeck(row), createdAt: row.created_at, nextCode: row.next_code || null, myVotes: mine };
}

export function recordVote({ code, voter, cardKey, vote }) {
  const session = selectSession.get(String(code).toUpperCase());
  if (!session) throw new Error('That session code does not exist');
  if (!validVoter(voter)) throw new Error('Missing device id');
  if (!parseDeck(session).some((card) => card.cardKey === cardKey)) {
    throw new Error('That card is not in this deck');
  }

  upsertVote.run({ code: session.code, voter, card_key: cardKey, vote });
  return getMatches(session.code);
}

/**
 * Titles at least two different people said yes to, newest agreement first.
 * Two is the threshold rather than "everyone" so a third phone joining late
 * cannot un-match a decision the couple already reached.
 */
export function getMatches(code) {
  const session = selectSession.get(String(code).toUpperCase());
  if (!session) return { code, matches: [], voters: 0 };

  const byKey = new Map(parseDeck(session).map((d) => [d.cardKey, d]));

  const yesByCard = new Map();
  const voters = new Set();

  for (const vote of selectVotes.all(session.code)) {
    voters.add(vote.voter);
    if (vote.vote !== 'yes') continue;
    if (!yesByCard.has(vote.card_key)) yesByCard.set(vote.card_key, new Set());
    yesByCard.get(vote.card_key).add(vote.voter);
  }

  const matches = [];
  for (const [cardKey, voterIds] of yesByCard) {
    if (voterIds.size < 2) continue;
    const item = byKey.get(cardKey);
    if (item) matches.push({ ...item, agreedBy: voterIds.size });
  }

  return { code: session.code, matches, voters: voters.size, nextCode: session.next_code || null };
}
