/**
 * External lists — fetch curated/popular/user lists from third-party services
 * and unify them into a single shape the matcher can consume.
 *
 * Providers:
 *   - mdblist   (needs MDBLIST_API_KEY in env — user's lists + top public lists)
 *   - tmdb      (needs TMDB_API_KEY — popular/top-rated/upcoming/trending)
 *   - letterboxd (no auth — RSS feeds for popular-this-week / popular-all-time / user lists)
 *   - trakt     (optional TRAKT_CLIENT_ID — trending/popular/anticipated)
 *
 * Unified list item shape:
 *   { imdbId, tmdbId, tvdbId, title, year, type, poster, source, sourceUrl }
 */

const MDBLIST_BASE = 'https://api.mdblist.com';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const TRAKT_BASE = 'https://api.trakt.tv';

function envKey(name) {
  return process.env[name] || null;
}

export function getAvailableSources() {
  return {
    mdblist: !!envKey('MDBLIST_API_KEY'),
    tmdb: !!envKey('TMDB_API_KEY'),
    letterboxd: true,
    trakt: !!envKey('TRAKT_CLIENT_ID'),
  };
}

/**
 * Where a failed request went, without its query string. The query carries the
 * API keys (apikey=, api_key=), and this text ends up in error messages that
 * are sent back to whoever asked: a made-up list id used to return the full
 * URL, key included, to any device on the network.
 */
function describe(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'external list';
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`${describe(url)}: ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`${describe(url)}: ${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ---------- MDBList ----------

export async function listMdblistTop() {
  const key = envKey('MDBLIST_API_KEY');
  if (!key) throw new Error('MDBLIST_API_KEY not configured');
  const data = await fetchJson(`${MDBLIST_BASE}/lists/top?apikey=${key}`);
  return (data || []).map((l) => ({
    id: String(l.id),
    name: l.name,
    description: l.description || '',
    itemCount: l.items || null,
    owner: l.user_name || null,
    source: 'mdblist',
    kind: 'list',
    url: l.url || null,
  }));
}

export async function listMdblistUser() {
  const key = envKey('MDBLIST_API_KEY');
  if (!key) throw new Error('MDBLIST_API_KEY not configured');
  const data = await fetchJson(`${MDBLIST_BASE}/lists/user?apikey=${key}`);
  return (data || []).map((l) => ({
    id: String(l.id),
    name: l.name,
    description: l.description || '',
    itemCount: l.items || null,
    owner: l.user_name || null,
    source: 'mdblist',
    kind: 'list',
    url: l.url || null,
    private: l.private || false,
  }));
}

export async function searchMdblistLists(query) {
  const key = envKey('MDBLIST_API_KEY');
  if (!key) throw new Error('MDBLIST_API_KEY not configured');
  const data = await fetchJson(`${MDBLIST_BASE}/lists/search?query=${encodeURIComponent(query)}&apikey=${key}`);
  return (data || []).map((l) => ({
    id: String(l.id),
    name: l.name,
    description: l.description || '',
    itemCount: l.items || null,
    owner: l.user_name || null,
    source: 'mdblist',
    kind: 'list',
  }));
}

export async function getMdblistItems(listId) {
  const key = envKey('MDBLIST_API_KEY');
  if (!key) throw new Error('MDBLIST_API_KEY not configured');
  const data = await fetchJson(`${MDBLIST_BASE}/lists/${encodeURIComponent(listId)}/items?apikey=${key}`);
  const arr = Array.isArray(data) ? data : (data.movies || []).concat(data.shows || []);
  return arr.map((it) => ({
    imdbId: it.imdb_id || null,
    tmdbId: it.id || it.tmdb_id || null,
    tvdbId: it.tvdb_id || null,
    title: it.title,
    year: it.release_year || it.year || null,
    type: it.mediatype === 'show' ? 'show' : 'movie',
    poster: it.poster ? (it.poster.startsWith('http') ? it.poster : `${TMDB_IMG}${it.poster}`) : null,
    source: 'mdblist',
  }));
}

// ---------- TMDB ----------

const TMDB_BUILTINS = [
  { id: 'movie:popular',     name: 'Popular Movies',         path: '/movie/popular',     type: 'movie' },
  { id: 'movie:top_rated',   name: 'Top Rated Movies',       path: '/movie/top_rated',   type: 'movie' },
  { id: 'movie:upcoming',    name: 'Upcoming Movies',        path: '/movie/upcoming',    type: 'movie' },
  { id: 'movie:now_playing', name: 'Now In Theaters',        path: '/movie/now_playing', type: 'movie' },
  { id: 'tv:popular',        name: 'Popular TV Shows',       path: '/tv/popular',        type: 'show'  },
  { id: 'tv:top_rated',      name: 'Top Rated TV Shows',     path: '/tv/top_rated',      type: 'show'  },
  { id: 'tv:on_the_air',     name: 'TV Shows On Air',        path: '/tv/on_the_air',     type: 'show'  },
  { id: 'trending:day',      name: 'Trending Today',         path: '/trending/all/day',  type: 'mixed' },
  { id: 'trending:week',     name: 'Trending This Week',     path: '/trending/all/week', type: 'mixed' },
];

export function listTmdbBuiltins() {
  return TMDB_BUILTINS.map((b) => ({
    id: b.id,
    name: b.name,
    description: 'Curated by TMDB',
    source: 'tmdb',
    kind: 'list',
    itemType: b.type,
  }));
}

async function tmdbDetailForId(tmdbId, mediaType) {
  const key = envKey('TMDB_API_KEY');
  const path = mediaType === 'tv' || mediaType === 'show' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  try {
    const data = await fetchJson(`${TMDB_BASE}${path}?api_key=${key}&append_to_response=external_ids`);
    return { imdbId: data.external_ids?.imdb_id || null };
  } catch {
    return { imdbId: null };
  }
}

export async function getTmdbBuiltinItems(id) {
  const key = envKey('TMDB_API_KEY');
  if (!key) throw new Error('TMDB_API_KEY not configured');
  const builtin = TMDB_BUILTINS.find((b) => b.id === id);
  if (!builtin) throw new Error(`Unknown TMDB list: ${id}`);

  const data = await fetchJson(`${TMDB_BASE}${builtin.path}?api_key=${key}`);
  const results = (data.results || []).slice(0, 40);

  // Best-effort imdb_id enrichment for the top N items. We do this in parallel
  // but rate-limit at 8 concurrent so we don't hammer TMDB.
  const concurrent = 8;
  const out = [];
  for (let i = 0; i < results.length; i += concurrent) {
    const batch = results.slice(i, i + concurrent);
    const enriched = await Promise.all(batch.map(async (it) => {
      const mediaType = it.media_type || (builtin.type === 'show' ? 'tv' : 'movie');
      const { imdbId } = await tmdbDetailForId(it.id, mediaType);
      const title = it.title || it.name;
      const releaseDate = it.release_date || it.first_air_date || '';
      return {
        imdbId,
        tmdbId: it.id,
        tvdbId: null,
        title,
        year: releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null,
        type: mediaType === 'tv' ? 'show' : 'movie',
        poster: it.poster_path ? `${TMDB_IMG}${it.poster_path}` : null,
        source: 'tmdb',
      };
    }));
    out.push(...enriched);
  }
  return out;
}

export async function getTmdbCustomListItems(listId) {
  const key = envKey('TMDB_API_KEY');
  if (!key) throw new Error('TMDB_API_KEY not configured');
  const data = await fetchJson(`${TMDB_BASE}/list/${encodeURIComponent(listId)}?api_key=${key}`);
  const items = data.items || [];
  return items.map((it) => ({
    imdbId: null,
    tmdbId: it.id,
    tvdbId: null,
    title: it.title || it.name,
    year: (it.release_date || it.first_air_date || '').slice(0, 4) ? parseInt((it.release_date || it.first_air_date).slice(0, 4), 10) : null,
    type: it.media_type === 'tv' ? 'show' : 'movie',
    poster: it.poster_path ? `${TMDB_IMG}${it.poster_path}` : null,
    source: 'tmdb',
  }));
}

// ---------- Letterboxd (RSS, no auth) ----------

const LETTERBOXD_BUILTINS = [
  { id: 'popular/this/week',  name: 'Popular This Week',  path: '/films/popular/this/week/rss/'  },
  { id: 'popular/this/month', name: 'Popular This Month', path: '/films/popular/this/month/rss/' },
  { id: 'popular/this/year',  name: 'Popular This Year',  path: '/films/popular/this/year/rss/'  },
  { id: 'popular',            name: 'Popular All Time',   path: '/films/popular/rss/'            },
];

export function listLetterboxdBuiltins() {
  return LETTERBOXD_BUILTINS.map((b) => ({
    id: b.id,
    name: b.name,
    description: 'Letterboxd community',
    source: 'letterboxd',
    kind: 'list',
  }));
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const tag = (name) => {
      const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`);
      const r = block.match(re);
      if (!r) return null;
      return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };
    items.push({
      title: tag('title'),
      link: tag('link'),
      description: tag('description'),
      letterboxdFilmTitle: tag('letterboxd:filmTitle'),
      letterboxdFilmYear: tag('letterboxd:filmYear'),
      tmdbMovieId: tag('tmdb:movieId'),
      tmdbTvId: tag('tmdb:tvId'),
    });
  }
  return items;
}

export async function getLetterboxdItems(listId) {
  // listId can be a built-in path like 'popular/this/week' OR a full
  // user list like '<username>/list/<list-slug>'.
  const path = LETTERBOXD_BUILTINS.find((b) => b.id === listId)?.path
    || `/${listId.replace(/^\/+/, '')}/rss/`;
  const xml = await fetchText(`https://letterboxd.com${path}`);
  const rss = parseRssItems(xml);
  return rss.slice(0, 50).map((it) => {
    const title = it.letterboxdFilmTitle || (it.title || '').replace(/, \d{4}$/, '');
    const yearStr = it.letterboxdFilmYear || ((it.title || '').match(/, (\d{4})$/)?.[1]);
    const year = yearStr ? parseInt(yearStr, 10) : null;
    const tmdbId = it.tmdbMovieId || it.tmdbTvId || null;
    return {
      imdbId: null,
      tmdbId: tmdbId ? parseInt(tmdbId, 10) : null,
      tvdbId: null,
      title,
      year,
      type: it.tmdbTvId ? 'show' : 'movie',
      poster: null,
      source: 'letterboxd',
    };
  }).filter((x) => x.title);
}

// ---------- Trakt (optional) ----------

const TRAKT_BUILTINS = [
  { id: 'trending:movies',     name: 'Trending Movies',     path: '/movies/trending',     type: 'movie' },
  { id: 'popular:movies',      name: 'Popular Movies',      path: '/movies/popular',      type: 'movie' },
  { id: 'anticipated:movies',  name: 'Anticipated Movies',  path: '/movies/anticipated',  type: 'movie' },
  { id: 'boxoffice:movies',    name: 'Box Office',          path: '/movies/boxoffice',    type: 'movie' },
  { id: 'trending:shows',      name: 'Trending Shows',      path: '/shows/trending',      type: 'show'  },
  { id: 'popular:shows',       name: 'Popular Shows',       path: '/shows/popular',       type: 'show'  },
  { id: 'anticipated:shows',   name: 'Anticipated Shows',   path: '/shows/anticipated',   type: 'show'  },
];

export function listTraktBuiltins() {
  if (!envKey('TRAKT_CLIENT_ID')) return [];
  return TRAKT_BUILTINS.map((b) => ({
    id: b.id,
    name: b.name,
    description: 'Trakt community',
    source: 'trakt',
    kind: 'list',
  }));
}

export async function getTraktItems(id) {
  const clientId = envKey('TRAKT_CLIENT_ID');
  if (!clientId) throw new Error('TRAKT_CLIENT_ID not configured');
  const builtin = TRAKT_BUILTINS.find((b) => b.id === id);
  if (!builtin) throw new Error(`Unknown Trakt list: ${id}`);

  const data = await fetchJson(`${TRAKT_BASE}${builtin.path}?limit=40&extended=full`, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
    },
  });

  return (data || []).map((row) => {
    const inner = row.movie || row.show || row;
    const ids = inner.ids || {};
    return {
      imdbId: ids.imdb || null,
      tmdbId: ids.tmdb || null,
      tvdbId: ids.tvdb || null,
      title: inner.title,
      year: inner.year || null,
      type: row.show ? 'show' : 'movie',
      poster: null,
      source: 'trakt',
    };
  });
}

// ---------- Featured rail (one curated row per provider for the landing UI) ----------

export async function getFeaturedLists() {
  const out = [];
  const avail = getAvailableSources();
  if (avail.tmdb) {
    out.push({ source: 'tmdb', name: 'TMDB', lists: listTmdbBuiltins().slice(0, 6) });
  }
  if (avail.mdblist) {
    try {
      const top = await listMdblistTop();
      out.push({ source: 'mdblist', name: 'MDBList Top', lists: top.slice(0, 6) });
    } catch (err) {
      console.warn('MDBList top failed:', err.message);
    }
  }
  if (avail.letterboxd) {
    out.push({ source: 'letterboxd', name: 'Letterboxd', lists: listLetterboxdBuiltins() });
  }
  if (avail.trakt) {
    out.push({ source: 'trakt', name: 'Trakt', lists: listTraktBuiltins().slice(0, 6) });
  }
  return out;
}

// ---------- Unified provider dispatch ----------

export async function getProviderListItems(provider, listId) {
  switch (provider) {
    case 'mdblist': return getMdblistItems(listId);
    case 'tmdb':
      if (listId.startsWith('movie:') || listId.startsWith('tv:') || listId.startsWith('trending:')) {
        return getTmdbBuiltinItems(listId);
      }
      return getTmdbCustomListItems(listId);
    case 'letterboxd': return getLetterboxdItems(listId);
    case 'trakt': return getTraktItems(listId);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function getProviderListings(provider) {
  switch (provider) {
    case 'mdblist': {
      const [user, top] = await Promise.all([
        listMdblistUser().catch(() => []),
        listMdblistTop().catch(() => []),
      ]);
      return { user, top };
    }
    case 'tmdb': return { builtin: listTmdbBuiltins() };
    case 'letterboxd': return { builtin: listLetterboxdBuiltins() };
    case 'trakt': return { builtin: listTraktBuiltins() };
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
