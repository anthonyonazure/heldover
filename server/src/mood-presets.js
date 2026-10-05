/**
 * Mood presets — semantic moods mapped to filter shapes the existing
 * applyFilters() engine understands. New moods get added here; the API
 * exposes them via /api/moods and they are referenced by id by Tonight Mode.
 */

export const MOODS = [
  {
    id: 'funny',
    label: 'Funny',
    emoji: '😂',
    description: 'Lighten the night',
    filters: { genres: ['Comedy'] },
  },
  {
    id: 'dark',
    label: 'Dark',
    emoji: '🌙',
    description: 'Heavy and slow burning',
    filters: {
      genres: ['Thriller', 'Horror', 'Crime', 'Mystery', 'Drama'],
      excludeGenres: ['Comedy', 'Family', 'Animation'],
    },
  },
  {
    id: 'short',
    label: 'Short',
    emoji: '⏱️',
    description: 'Under 100 minutes',
    filters: { maxRuntime: 100, type: 'movie' },
  },
  {
    id: 'familiar',
    label: 'Familiar',
    emoji: '🛋️',
    description: 'Things you’ve loved before',
    filters: { onlyLiked: true },
  },
  {
    id: 'new',
    label: 'New',
    emoji: '✨',
    description: 'Added in the last 60 days',
    filters: { addedWithinDays: 60 },
  },
  {
    id: 'epic',
    label: 'Epic',
    emoji: '🎬',
    description: 'Big runtime, big ratings',
    filters: { minRuntime: 130, minRating: 7.5 },
  },
  {
    id: 'cozy',
    label: 'Cozy',
    emoji: '🫖',
    description: 'Warm and easy',
    filters: { genres: ['Family', 'Romance', 'Animation', 'Comedy'], excludeGenres: ['Horror', 'War'] },
  },
  {
    id: 'mindbend',
    label: 'Mind-Bend',
    emoji: '🌀',
    description: 'Twists, paradoxes, ideas',
    filters: { genres: ['Sci-Fi', 'Science Fiction', 'Mystery', 'Thriller'], minRating: 7 },
  },
];

export function getMoods() {
  return MOODS.map((mood) => {
    const meta = { ...mood };
    delete meta.filters;
    return meta;
  });
}

export function getMoodById(id) {
  return MOODS.find((m) => m.id === id) || null;
}
