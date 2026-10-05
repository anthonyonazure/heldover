import { OMDB_DAILY_LIMIT, getApiUsage } from './ratings-store.js';

/**
 * Get the current OMDB usage stats (for monitoring/debugging).
 */
export function getOmdbUsageStats() {
  const today = new Date().toISOString().split('T')[0];
  const row = getApiUsage.get('omdb');
  if (!row || row.last_reset !== today) {
    return { dailyCount: 0, limit: OMDB_DAILY_LIMIT, remaining: OMDB_DAILY_LIMIT, resetDate: today };
  }
  return {
    dailyCount: row.daily_count,
    limit: OMDB_DAILY_LIMIT,
    remaining: Math.max(0, OMDB_DAILY_LIMIT - row.daily_count),
    resetDate: row.last_reset,
  };
}
