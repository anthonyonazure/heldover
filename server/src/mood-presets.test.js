import { describe, expect, test } from 'bun:test';
import { MOODS, getMoods, getMoodById } from './mood-presets.js';

describe('mood presets', () => {
  test('getMoods lists every mood without its internal filters', () => {
    const moods = getMoods();
    expect(moods.map((m) => m.id)).toEqual(MOODS.map((m) => m.id));
    for (const mood of moods) {
      expect(mood).not.toHaveProperty('filters');
      expect(mood.label).toBeTruthy();
    }
  });

  test('getMoods does not strip filters from the shared MOODS table', () => {
    getMoods();
    expect(MOODS.every((m) => m.filters)).toBe(true);
  });

  test('getMoodById returns the full preset, or null when unknown', () => {
    const first = MOODS[0];
    expect(getMoodById(first.id)).toBe(first);
    expect(getMoodById('not-a-mood')).toBeNull();
  });
});
