/**
 * Match external list items against a Plex library.
 *
 * Match priority:
 *   1. IMDB GUID exact match  (imdb://tt1234567)
 *   2. TMDB GUID exact match  (tmdb://12345)
 *   3. TVDB GUID exact match  (tvdb://6789)
 *   4. Title + year fallback (normalized title + same year)
 *
 * Returns the original list item with `inLibrary` + an embedded `libraryItem`
 * pointer (ratingKey, title, year, posterUrl) when matched.
 */

function normalizeTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-') // unicode dashes
    .replace(/[’'`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function buildIndex(libraryItems) {
  const byImdb = new Map();
  const byTmdb = new Map();
  const byTvdb = new Map();
  const byTitleYear = new Map();

  for (const it of libraryItems) {
    const guids = it.guids || [];
    for (const g of guids) {
      if (typeof g !== 'string') continue;
      if (g.startsWith('imdb://')) byImdb.set(g.slice(7), it);
      else if (g.startsWith('tmdb://')) byTmdb.set(g.slice(7), it);
      else if (g.startsWith('tvdb://')) byTvdb.set(g.slice(7), it);
    }
    const norm = normalizeTitle(it.title);
    if (norm && it.year) byTitleYear.set(`${norm}::${it.year}`, it);
  }

  return { byImdb, byTmdb, byTvdb, byTitleYear };
}

function lookup(externalItem, index) {
  if (externalItem.imdbId && index.byImdb.has(String(externalItem.imdbId))) {
    return index.byImdb.get(String(externalItem.imdbId));
  }
  if (externalItem.tmdbId && index.byTmdb.has(String(externalItem.tmdbId))) {
    return index.byTmdb.get(String(externalItem.tmdbId));
  }
  if (externalItem.tvdbId && index.byTvdb.has(String(externalItem.tvdbId))) {
    return index.byTvdb.get(String(externalItem.tvdbId));
  }
  if (externalItem.title && externalItem.year) {
    const key = `${normalizeTitle(externalItem.title)}::${externalItem.year}`;
    if (index.byTitleYear.has(key)) return index.byTitleYear.get(key);
  }
  return null;
}

function libraryCard(it, serverKey) {
  return {
    ratingKey: it.ratingKey,
    serverKey: serverKey || null,
    title: it.title,
    year: it.year,
    type: it.type,
    posterUrl: it.posterUrl || it.thumb || null,
    duration: it.duration || null,
    imdbRating: it.imdbRating || null,
    tmdbRating: it.tmdbRating || null,
    contentRating: it.contentRating || null,
    genres: it.genres || [],
    viewCount: it.viewCount || 0,
  };
}

export function matchListItems({ listItems, libraryItems, serverKey }) {
  if (!Array.isArray(listItems)) return [];
  const index = buildIndex(libraryItems || []);
  return listItems.map((ext) => {
    const found = lookup(ext, index);
    return {
      ...ext,
      inLibrary: !!found,
      libraryItem: found ? libraryCard(found, serverKey) : null,
    };
  });
}

/**
 * Match list items against multiple libraries (one library per serverKey) and
 * return the merged result. Used when the user has multiple libraries on
 * multiple servers and wants to know "is X in any of my libraries?"
 */
export function matchListItemsAcross({ listItems, librariesByServer }) {
  if (!Array.isArray(listItems)) return [];
  const indexes = [];
  for (const { serverKey, items } of librariesByServer) {
    indexes.push({ serverKey, index: buildIndex(items || []) });
  }
  return listItems.map((ext) => {
    for (const { serverKey, index } of indexes) {
      const found = lookup(ext, index);
      if (found) {
        return { ...ext, inLibrary: true, libraryItem: libraryCard(found, serverKey) };
      }
    }
    return { ...ext, inLibrary: false, libraryItem: null };
  });
}
