import React, { useEffect, useState } from 'react';
import { getWrapped } from '../lib/api';

function StatTile({ label, value, sub }) {
  return (
    <div className="bg-surface-800 rounded-2xl p-5 border border-surface-700">
      <div className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-1.5">{label}</div>
      <div className="text-2xl sm:text-3xl font-bold text-gray-50">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

function MiniCard({ item, accent }) {
  if (!item) return null;
  return (
    <div className="flex gap-3 items-center bg-surface-900 rounded-xl p-3 border border-surface-700">
      {item.poster ? (
        <img loading="lazy" decoding="async" src={item.poster} alt="" className="w-14 h-20 object-cover rounded" />
      ) : (
        <div className="w-14 h-20 bg-surface-700 rounded flex items-center justify-center text-2xl">🎬</div>
      )}
      <div className="min-w-0">
        <div className={`text-[10px] uppercase tracking-wider font-bold ${accent}`}>{item._label}</div>
        <div className="text-sm font-semibold text-gray-100 truncate">{item.title}</div>
        <div className="text-xs text-gray-400">
          {item.year ? `${item.year}` : ''}
          {item.viewCount > 1 ? ` · watched ${item.viewCount}x` : ''}
          {item.rating ? ` · ★ ${item.rating.toFixed(1)}` : ''}
        </div>
      </div>
    </div>
  );
}

export default function Wrapped({ serverKey, libraryKey, onLeave }) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!serverKey || !libraryKey) {
      setError('Pick a library first, then re-open Wrapped.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getWrapped(serverKey, libraryKey, days)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [serverKey, libraryKey, days]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-900 via-surface-900 to-black py-8 sm:py-12 px-4 sm:px-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-amber-400 font-bold">Heldover</div>
            <h1 className="text-3xl sm:text-5xl font-bold text-gray-50 leading-tight">Wrapped</h1>
            <p className="text-sm text-gray-400 mt-2">Your last {days} days, summarized.</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              className="bg-surface-800 border border-surface-700 rounded-lg px-3 py-1.5 text-xs text-gray-100"
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>6 months</option>
              <option value={365}>1 year</option>
            </select>
            <button onClick={onLeave} className="text-xs px-3 py-1.5 rounded-lg bg-surface-800 text-gray-300 hover:bg-surface-700 border border-surface-700">Close</button>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-32 bg-surface-800 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <div className="text-amber-300 p-6 bg-surface-800 rounded-2xl border border-surface-700">{error}</div>
        ) : data && data.totalWatched === 0 ? (
          <div className="text-gray-400 p-6 bg-surface-800 rounded-2xl border border-surface-700">
            Nothing watched in this window. Try a longer one.
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
              <StatTile label="Things watched" value={data.totalWatched} sub={`${data.movieCount} movies · ${data.showCount} shows`} />
              <StatTile label="Time watched" value={data.totalRuntimeFormatted} />
              <StatTile label="Top genre" value={data.topGenres[0]?.genre || '—'} sub={data.topGenres[0] ? `${data.topGenres[0].count} titles` : ''} />
              <StatTile label="Avg rating" value={data.avgRating ? data.avgRating.toFixed(1) : '—'} />
              <StatTile label="Top decade" value={data.topDecade?.decade || '—'} sub={data.topDecade ? `${data.topDecade.count} titles` : ''} />
              <StatTile label="Genres" value={data.topGenres.length} sub={data.topGenres.map((g) => g.genre).slice(0, 3).join(', ')} />
            </div>

            <div className="grid sm:grid-cols-2 gap-3 mb-6">
              <MiniCard item={data.highestRated ? { ...data.highestRated, _label: 'Highest rated' } : null} accent="text-amber-400" />
              <MiniCard item={data.mostRewatched ? { ...data.mostRewatched, _label: 'Most rewatched' } : null} accent="text-cyan-400" />
              <MiniCard item={data.longestWatched ? { ...data.longestWatched, _label: 'Longest' } : null} accent="text-emerald-400" />
            </div>

            {data.sample.length > 0 && (
              <div>
                <h3 className="text-sm font-bold uppercase tracking-wide text-gray-400 mb-3">Some of what you watched</h3>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {data.sample.map((it, i) => (
                    <div key={i} className="aspect-[2/3] bg-surface-800 rounded-lg overflow-hidden border border-surface-700">
                      {it.poster ? (
                        <img src={it.poster} alt={it.title} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-600 text-2xl">🎬</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
