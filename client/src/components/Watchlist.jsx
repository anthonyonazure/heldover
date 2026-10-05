import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getWatchlist, removeFromWatchlist, markWatched } from '../lib/api';
import RatingBadge from './RatingBadge';
import { reportProblem } from '../lib/notice';

const SORT_OPTIONS = [
  { value: 'dateAdded', label: 'Date Added' },
  { value: 'rating', label: 'Rating' },
  { value: 'title', label: 'Title' },
];

const TABS = [
  { value: 'all', label: 'All' },
  { value: 'unwatched', label: 'Unwatched' },
  { value: 'watched', label: 'Watched' },
];

function WatchlistCard({ item, onRemove, onMarkWatched }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const posterUrl = item.posterUrl || item.thumb;

  return (
    <div className="relative group rounded-lg overflow-hidden bg-surface-800 border border-surface-700 hover:border-surface-600 transition-all duration-300 hover:shadow-xl hover:shadow-black/30">
      {/* Poster */}
      <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
        {!imgError && posterUrl ? (
          <>
            {!imgLoaded && <div className="absolute inset-0 animate-pulse bg-surface-700" />}
            <img
              src={posterUrl}
              alt={item.title}
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
              className={`w-full h-full object-cover transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
            </svg>
          </div>
        )}

        {/* Watched overlay */}
        {item.watched && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}

        {/* Rating badges */}
        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
          <div className="flex gap-1 flex-wrap">
            {item.imdbRating != null && <RatingBadge value={item.imdbRating} type="imdb" size="sm" />}
            {item.rottenTomatoes != null && <RatingBadge value={item.rottenTomatoes} type="rt" size="sm" />}
            {item.tmdbRating != null && <RatingBadge value={item.tmdbRating} type="tmdb" size="sm" />}
          </div>
        </div>

        {/* Hover actions */}
        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center gap-2 p-3">
          {!item.watched && (
            <button
              onClick={(e) => { e.stopPropagation(); onMarkWatched(item); }}
              className="w-full px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Mark Watched
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(item); }}
            className="w-full px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Remove
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="p-2.5">
        <h3 className="text-sm font-semibold text-gray-100 truncate leading-tight" title={item.title}>
          {item.title}
        </h3>
        <div className="flex items-center gap-2 mt-1">
          {item.year && <span className="text-xs text-gray-500">{item.year}</span>}
          {item.type && <span className="text-[10px] text-gray-600 uppercase">{item.type}</span>}
        </div>
      </div>
    </div>
  );
}

export default function Watchlist({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('all');
  const [sortBy, setSortBy] = useState('dateAdded');

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getWatchlist();
      setItems(Array.isArray(data) ? data : data.items || []);
    } catch (err) {
      reportProblem("Couldn't load your watchlist.", err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleRemove = async (item) => {
    try {
      await removeFromWatchlist(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err) {
      reportProblem("Couldn't remove that from your watchlist. Try again.", err);
    }
  };

  const handleMarkWatched = async (item) => {
    try {
      await markWatched(item.id);
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, watched: true } : i))
      );
    } catch (err) {
      reportProblem("Couldn't mark that as watched. Try again.", err);
    }
  };

  const filteredAndSorted = useMemo(() => {
    let result = [...items];

    // Filter by tab
    if (tab === 'unwatched') result = result.filter((i) => !i.watched);
    if (tab === 'watched') result = result.filter((i) => i.watched);

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'rating':
          return (b.imdbRating ?? 0) - (a.imdbRating ?? 0);
        case 'title':
          return (a.title || '').localeCompare(b.title || '');
        case 'dateAdded':
        default:
          return new Date(b.addedAt || 0).getTime() - new Date(a.addedAt || 0).getTime();
      }
    });

    return result;
  }, [items, tab, sortBy]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-900">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface-900/95 backdrop-blur-sm border-b border-surface-700">
        <div className="flex items-center justify-between px-4 py-3 max-w-7xl mx-auto">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5 2h14a1 1 0 011 1v19.143a.5.5 0 01-.766.424L12 18.03l-7.234 4.536A.5.5 0 014 22.143V3a1 1 0 011-1z" />
            </svg>
            <div>
              <h1 className="text-lg font-bold text-gray-100">My Watchlist</h1>
              <p className="text-xs text-gray-500">{items.length} item{items.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-white transition-smooth"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs and sort */}
        <div className="flex items-center justify-between px-4 pb-3 max-w-7xl mx-auto">
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.value}
                onClick={() => setTab(t.value)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-smooth ${
                  tab === t.value
                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    : 'text-gray-400 hover:text-gray-300 hover:bg-surface-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="px-2 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-amber-500/50 transition-smooth"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 max-w-7xl mx-auto w-full">
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-lg overflow-hidden bg-surface-800 border border-surface-700 animate-pulse">
                <div className="aspect-[2/3] bg-surface-700" />
                <div className="p-2.5 space-y-2">
                  <div className="h-4 bg-surface-700 rounded w-3/4" />
                  <div className="h-3 bg-surface-700 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredAndSorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <svg className="w-16 h-16 text-gray-700 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 3a1 1 0 011-1h12a1 1 0 011 1v18.143a.5.5 0 01-.766.424L12 17.03l-6.234 4.536A.5.5 0 015 21.143V3z" />
            </svg>
            <h3 className="text-lg font-medium text-gray-400 mb-1">Your watchlist is empty</h3>
            <p className="text-sm text-gray-600">
              {tab !== 'all'
                ? `No ${tab} items. Try a different filter.`
                : 'Browse your library and bookmark titles to watch later.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
            {filteredAndSorted.map((item) => (
              <WatchlistCard
                key={item.id}
                item={item}
                onRemove={handleRemove}
                onMarkWatched={handleMarkWatched}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
