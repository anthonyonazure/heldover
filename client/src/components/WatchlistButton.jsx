import React, { useState, useEffect } from 'react';
import { checkWatchlist, addToWatchlist, removeFromWatchlist } from '../lib/api';
import { reportProblem } from '../lib/notice';

export default function WatchlistButton({ item, size = 'sm' }) {
  const [onList, setOnList] = useState(false);
  const [watchlistId, setWatchlistId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [animating, setAnimating] = useState(false);

  const plexKey = item?.ratingKey || item?.key;

  useEffect(() => {
    if (!plexKey) return;
    let cancelled = false;
    checkWatchlist(plexKey)
      .then((data) => {
        if (cancelled) return;
        setOnList(!!data.onWatchlist);
        setWatchlistId(data.id || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [plexKey]);

  const handleClick = async (e) => {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    setAnimating(true);

    try {
      if (onList) {
        await removeFromWatchlist(watchlistId);
        setOnList(false);
        setWatchlistId(null);
      } else {
        const result = await addToWatchlist({
          plexKey,
          title: item.title,
          year: item.year,
          posterUrl: item.posterUrl || item.thumb,
          type: item.type,
          tmdbId: item.tmdbId,
          imdbRating: item.imdbRating,
          rottenTomatoes: item.rottenTomatoes,
          tmdbRating: item.tmdbRating,
        });
        setOnList(true);
        setWatchlistId(result.id || null);
      }
    } catch (err) {
      reportProblem("Couldn't update your watchlist. Try again.", err);
    } finally {
      setLoading(false);
      setTimeout(() => setAnimating(false), 300);
    }
  };

  const sizeClasses = size === 'md'
    ? 'p-2 rounded-lg'
    : 'p-1 rounded';

  const iconSize = size === 'md' ? 'w-5 h-5' : 'w-4 h-4';

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`${sizeClasses} transition-all duration-200 ${
        onList
          ? 'text-amber-400 hover:text-amber-300'
          : 'text-gray-400 hover:text-amber-400'
      } hover:bg-black/30 disabled:opacity-50 ${
        animating ? 'scale-125' : 'scale-100'
      }`}
      title={onList ? 'Remove from Watchlist' : 'Add to Watchlist'}
    >
      {onList ? (
        <svg className={iconSize} viewBox="0 0 24 24" fill="currentColor">
          <path d="M5 2h14a1 1 0 011 1v19.143a.5.5 0 01-.766.424L12 18.03l-7.234 4.536A.5.5 0 014 22.143V3a1 1 0 011-1z" />
        </svg>
      ) : (
        <svg className={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3a1 1 0 011-1h12a1 1 0 011 1v18.143a.5.5 0 01-.766.424L12 17.03l-6.234 4.536A.5.5 0 015 21.143V3z" />
        </svg>
      )}
    </button>
  );
}
