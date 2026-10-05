/**
 * Find duplicate items across all libraries.
 * Groups by normalized title + year. Returns groups where count > 1.
 *
 * @param {Array} allItems - Items from all libraries, each should have serverName/libraryTitle metadata
 * @returns {Array} Array of duplicate groups: { title, year, count, copies: [...] }
 */
export function findDuplicates(allItems) {
  if (!allItems || allItems.length === 0) return [];

  const groups = new Map();

  for (const item of allItems) {
    // Normalize title: lowercase, trim, remove special chars for matching
    const normalizedTitle = (item.title || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ');

    const key = `${normalizedTitle}|${item.year || 'unknown'}`;

    if (!groups.has(key)) {
      groups.set(key, {
        title: item.title,
        year: item.year,
        copies: [],
      });
    }

    const group = groups.get(key);
    group.copies.push({
      ratingKey: item.ratingKey,
      title: item.title,
      year: item.year,
      type: item.type,
      serverName: item.serverName || null,
      serverKey: item.serverKey || null,
      libraryTitle: item.libraryTitle || null,
      libraryKey: item.libraryKey || null,
      duration: item.duration,
      contentRating: item.contentRating,
      thumb: item.thumb,
      imdbRating: item.imdbRating || null,
      tmdbRating: item.tmdbRating || null,
      viewCount: item.viewCount || 0,
    });
  }

  // Filter to only groups with duplicates, sort by count descending
  const duplicates = [];
  for (const [, group] of groups) {
    if (group.copies.length > 1) {
      duplicates.push({
        title: group.title,
        year: group.year,
        count: group.copies.length,
        copies: group.copies,
      });
    }
  }

  duplicates.sort((a, b) => b.count - a.count);
  return duplicates;
}
