import React, { useState, useEffect } from 'react';
import { getTrending } from '../lib/api';
import RatingBadge from './RatingBadge';
import ScrollRow from './ScrollRow';

function TrendingCard({ item }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const posterUrl = item.posterUrl || item.poster_path
    ? `https://image.tmdb.org/t/p/w300${item.poster_path}`
    : null;

  return (
    // No hand cursor here on purpose. These come from TMDB rather than from
    // any library, so there is nothing to open, and a card that looks clickable
    // and does nothing when clicked reads as a broken app.
    <div className="flex-shrink-0 w-[105px] sm:w-[180px] group">
      <div className="relative rounded-xl overflow-hidden bg-surface-850 border border-white/5 hover:border-amber-400/40 hover:scale-[1.06] hover:z-10 transition-all duration-300 ease-out hover:shadow-2xl hover:shadow-black/50">
        <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
          {!imgError && (posterUrl || item.posterUrl) ? (
            <>
              {!imgLoaded && <div className="absolute inset-0 animate-pulse bg-surface-700" />}
              <img
                src={item.posterUrl || posterUrl}
                alt={item.title || item.name}
                loading="lazy"
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgError(true)}
                className={`w-full h-full object-cover transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
              />
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600">
              <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
              </svg>
            </div>
          )}

          {/* TMDB rating badge */}
          {(item.tmdbRating || item.vote_average) && (
            <div className="absolute bottom-1.5 left-1.5">
              <RatingBadge value={item.tmdbRating || item.vote_average} type="tmdb" size="sm" />
            </div>
          )}
        </div>

        <div className="p-2">
          <h4 className="text-xs font-semibold text-gray-100 truncate" title={item.title || item.name}>
            {item.title || item.name}
          </h4>
          <span className="text-[10px] text-gray-500">
            {item.year || (item.release_date || item.first_air_date || '').slice(0, 4) || ''}
          </span>
        </div>
      </div>
    </div>
  );
}

function TrendingSection({ title, type }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getTrending(type, 'week')
      .then((data) => {
        setItems(Array.isArray(data) ? data : data.results || data.items || []);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [type]);

  if (!loading && items.length === 0) return null;

  return (
    <div className="mb-4">
      <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wide mb-3 flex items-center gap-2">
        <svg className="w-4 h-4 text-red-500" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13 7.5a1 1 0 00-1.707-.707l-2 2a1 1 0 000 1.414l2 2A1 1 0 0013 11.5V10a4 4 0 110 8h-1a1 1 0 100 2h1a6 6 0 000-12v-1z" />
        </svg>
        {title}
      </h2>

      {loading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-[105px] sm:w-[160px] animate-pulse">
              <div className="aspect-[2/3] bg-surface-700 rounded-lg" />
              <div className="mt-2 h-3 bg-surface-700 rounded w-3/4" />
            </div>
          ))}
        </div>
      ) : (
        <ScrollRow className="gap-2.5 sm:gap-4 pb-3" ariaLabel={title}>
          {items.map((item, i) => (
            <TrendingCard key={item.id || item.tmdbId || i} item={item} />
          ))}
        </ScrollRow>
      )}
    </div>
  );
}

export default function TrendingRow() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-6">
      <button
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex items-center gap-2 group mb-3"
      >
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wide group-hover:text-accent transition-smooth">
          Trending This Week
        </h2>
      </button>

      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          collapsed ? 'max-h-0 opacity-0' : 'max-h-[800px] opacity-100'
        }`}
      >
        <TrendingSection title="Trending Movies" type="movie" />
        <TrendingSection title="Trending TV" type="tv" />
      </div>
    </div>
  );
}
