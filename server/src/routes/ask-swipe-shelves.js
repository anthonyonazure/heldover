import { profileIdFrom } from '../profiles.js';
import { MOODS, getMoodById } from '../mood-presets.js';
import { getNotInterestedSet } from '../feedback.js';
import { stats as posterCacheStats } from '../poster-cache.js';
import { parseVoiceQuery } from '../voice-parse.js';
import { createSession, getSession, getMatches, recordVote } from '../swipe.js';
import { indexSize, queryRated } from '../corpus-index.js';
import { app, clampCount } from '../app.js';
import { warmPostersFor } from './servers-posters.js';

/**
 * POST /api/ask
 * Body: { question }
 *
 * "something funny under two hours, nothing sad" — plain words in, a shelf of
 * actual titles out. The filter panel can express all of this already, but
 * expressing it means understanding fourteen controls. This is the same engine
 * with a sentence as the interface.
 */
app.post('/api/ask', (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ error: 'question is required' });
    }

    const profileId = profileIdFrom(req);
    const count = clampCount(req.query.count, 24, 60);
    const { filters } = parseVoiceQuery(String(question));

    if (indexSize() === 0) {
      return res.json({ question, understood: [], items: [], count: 0, stillReading: true });
    }

    let items = queryRated({ ...filters, limit: count * 4 });

    const skip = getNotInterestedSet(profileId);
    items = items.filter((item) => !skip.has(item));

    // Say back what was actually understood. A silent misread ("nothing sad"
    // quietly ignored) is worse than a short list, because there is no way to
    // tell the difference between "no matches" and "I did not understand you".
    const understood = [];
    if (filters.genres?.length) understood.push(filters.genres.join(' or '));
    if (filters.excludeGenres?.length) understood.push(`not ${filters.excludeGenres.join(' or ')}`);
    if (filters.maxRuntime) understood.push(`under ${filters.maxRuntime} minutes`);
    if (filters.minRuntime) understood.push(`over ${filters.minRuntime} minutes`);
    if (filters.minRating) understood.push(`rated ${filters.minRating}+`);
    if (filters.yearFrom || filters.yearTo) {
      understood.push(`${filters.yearFrom || 'any'} to ${filters.yearTo || 'now'}`);
    }
    if (filters.type) understood.push(filters.type === 'show' ? 'TV' : 'movies');

    // Heard but not acted on. The index has no cast list, so an actor cannot
    // narrow the results; saying "starring X" next to films without X in them
    // was the silent misread this list exists to prevent.
    const ignored = [];
    if (filters.actor) ignored.push(`starring ${filters.actor} (searching by actor is not supported yet)`);

    res.json({
      question,
      understood,
      ignored,
      filters,
      items: items.slice(0, count),
      count: Math.min(items.length, count),
      totalMatches: items.length,
    });
  } catch (err) {
    console.error('Error answering ask:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Couples swipe. Two phones, one deck, first mutual yes wins.
 */
app.post('/api/swipe/session', (req, res) => {
  try {
    const size = clampCount(req.body?.size, 40, 100);
    const moodId = req.body?.mood;

    const mood = moodId ? getMoodById(moodId) : null;
    const pool = queryRated({ ...(mood ? mood.filters : {}), limit: 400 });
    if (pool.length === 0) {
      return res.status(503).json({ error: 'Still reading your libraries — try again in a minute' });
    }

    res.json(createSession(pool, size, req.body?.previousCode || null));
  } catch (err) {
    console.error('Error creating swipe session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/swipe/session/:code', (req, res) => {
  const session = getSession(req.params.code, req.query.voter);
  if (!session) return res.status(404).json({ error: 'That session code does not exist' });
  res.json({ ...session, ...getMatches(session.code) });
});

app.post('/api/swipe/vote', (req, res) => {
  try {
    const { code, cardKey, voter, vote } = req.body || {};
    if (!code || !cardKey || !voter || !['yes', 'no'].includes(vote)) {
      return res.status(400).json({ error: 'code, cardKey, voter and vote (yes|no) are required' });
    }
    res.json(recordVote({ code, voter, cardKey, vote }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/swipe/matches/:code', (req, res) => {
  res.json(getMatches(req.params.code));
});

/**
 * GET /api/health/memory
 * What this process is actually holding. Added after the app quietly grew to
 * 1.5GB and started evicting other things on the machine.
 */
app.get('/api/health/memory', (req, res) => {
  const mem = process.memoryUsage();
  const mb = (n) => Math.round(n / 1024 / 1024);
  res.json({
    residentMB: mb(mem.rss),
    heapUsedMB: mb(mem.heapUsed),
    heapTotalMB: mb(mem.heapTotal),
    externalMB: mb(mem.external),
    indexedTitles: indexSize(),
    // On disk rather than in memory on purpose: this process has run out of
    // heap before, and posters are exactly the kind of bulk that should never
    // be held in RAM.
    posterCache: (() => {
      const { count, bytes } = posterCacheStats();
      return { posters: count, diskMB: mb(bytes) };
    })(),
  });
});

/**
 * GET /api/shelves
 * One-tap rows for the front page — Cozy, Short, Familiar and friends — drawn
 * from every library at once rather than making someone pick a library first.
 *
 * This is the "she should not have to filter anything" surface. The filtering
 * already exists; what was missing was somewhere to land before you have made
 * any choices at all.
 */
app.get('/api/shelves', (req, res) => {
  try {
    // The ceiling is what a shelf can be swiped through, not what is drawn at
    // once — the client reveals a slice at a time. Too low a ceiling and a
    // phone runs out of posters mid-swipe with no way to ask for more.
    const perShelf = clampCount(req.query.count, 20, 100);
    // Each name once, and only names the app knows. Every name runs one query
    // over the whole index before anything is sent, so the list used to
    // decide how much work one request caused: "funny" a hundred times ran a
    // hundred queries and sent a hundred copies of the shelf, while every
    // other device waited. A name the app does not know is skipped, not
    // refused, so an older page asking for a preset that has since gone
    // still gets its other shelves.
    const requested = [
      ...new Set(
        String(req.query.moods || 'cozy,short,new,funny,mindbend,epic')
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean)
      ),
    ]
      .filter((id) => getMoodById(id))
      .slice(0, MOODS.length);

    const shelves = [];
    for (const moodId of requested) {
      const mood = getMoodById(moodId);
      // "Familiar" needs a history of thumbs to mean anything; until someone
      // has rated things it would just be an empty row.
      if (!mood || mood.filters.onlyLiked) continue;

      const items = queryRated({ ...mood.filters, limit: perShelf });
      if (items.length) {
        shelves.push({
          id: mood.id,
          label: mood.label,
          emoji: mood.emoji,
          description: mood.description,
          items,
        });
      }
    }

    // The covers this page is about to show are known now, well before the
    // browser gets around to asking for them, so the waiting is done while
    // nobody is looking at an empty grid.
    warmPostersFor(shelves.flatMap((shelf) => shelf.items));

    res.json({ shelves, indexedTitles: indexSize(), librariesSearched: indexSize() > 0 ? 1 : 0 });
  } catch (err) {
    console.error('Error building shelves:', err.message);
    res.status(500).json({ error: err.message });
  }
});
