import React, { useState, useEffect } from 'react';
import { getStats } from '../lib/api';
import RatingBadge from './RatingBadge';

function StatCard({ label, value, icon }) {
  return (
    <div className="bg-surface-800 rounded-lg border border-surface-700 p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{icon}</span>
        <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-xl font-bold text-gray-100">{value}</p>
    </div>
  );
}

function BarChart({ data, label, colorClass = 'bg-amber-500' }) {
  if (!data || data.length === 0) return null;
  const maxVal = Math.max(...data.map((d) => d.count));

  return (
    <div className="bg-surface-800 rounded-lg border border-surface-700 p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">{label}</h3>
      <div className="space-y-1.5 max-h-64 overflow-y-auto pr-2">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-2">
            <span className="text-[11px] text-gray-400 w-24 shrink-0 truncate text-right" title={d.name}>
              {d.name}
            </span>
            <div className="flex-1 bg-surface-700 rounded-full h-4 overflow-hidden">
              <div
                className={`h-full ${colorClass} rounded-full transition-all duration-500`}
                style={{ width: `${maxVal > 0 ? (d.count / maxVal) * 100 : 0}%` }}
              />
            </div>
            <span className="text-[11px] text-gray-500 w-8 shrink-0">{d.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopTenList({ items }) {
  if (!items || items.length === 0) return null;

  return (
    <div className="bg-surface-800 rounded-lg border border-surface-700 p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">Top 10 Highest Rated</h3>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={item.ratingKey || i} className="flex items-center gap-3">
            <span className="text-xs font-bold text-amber-400 w-5 shrink-0 text-right">
              {i + 1}
            </span>
            {(item.posterUrl || item.thumb) && (
              <img loading="lazy" decoding="async"
                src={item.posterUrl || item.thumb}
                alt={item.title}
                className="w-8 h-12 object-cover rounded shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-200 truncate">{item.title}</p>
              <div className="flex gap-1 mt-0.5">
                {item.imdbRating != null && <RatingBadge value={item.imdbRating} type="imdb" size="sm" />}
                {item.rottenTomatoes != null && <RatingBadge value={item.rottenTomatoes} type="rt" size="sm" />}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatRuntime(totalMs) {
  if (!totalMs) return '0h';
  const totalMinutes = Math.round(totalMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  return parts.join(' ') || '< 1 hour';
}

export default function StatsPanel({ serverKey, libraryKey, onClose }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!serverKey || !libraryKey) return;
    setLoading(true);
    setError(null);

    getStats(serverKey, libraryKey)
      .then((data) => setStats(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [serverKey, libraryKey]);

  if (loading) {
    return (
      <div className="mb-6 bg-surface-800 rounded-lg border border-surface-700 p-8">
        <div className="flex items-center justify-center gap-3">
          <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Loading stats...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-6 bg-surface-800 rounded-lg border border-surface-700 p-6 text-center">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wide flex items-center gap-2">
          <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          Library Stats
        </h2>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-gray-300 transition-smooth"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard label="Total Items" value={stats.totalItems?.toLocaleString() ?? 0} icon="🎬" />
        <StatCard label="Avg Rating" value={stats.avgRating?.toFixed(1) ?? 'N/A'} icon="⭐" />
        <StatCard label="Total Runtime" value={formatRuntime(stats.totalRuntime)} icon="⏱" />
        <StatCard label="Genres" value={stats.genreDistribution?.length ?? 0} icon="🎭" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <BarChart
          data={stats.genreDistribution}
          label="Genre Distribution"
          colorClass="bg-amber-500"
        />
        <BarChart
          data={stats.decadeDistribution}
          label="By Decade"
          colorClass="bg-blue-500"
        />
      </div>

      {/* Rating distribution */}
      {stats.ratingDistribution && stats.ratingDistribution.length > 0 && (
        <div className="mb-4">
          <BarChart
            data={stats.ratingDistribution}
            label="Rating Distribution"
            colorClass="bg-green-500"
          />
        </div>
      )}

      {/* Top 10 */}
      <TopTenList items={stats.topRated} />
    </div>
  );
}
