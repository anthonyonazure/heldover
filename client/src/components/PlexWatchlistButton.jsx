import React, { useState } from 'react';
import { addToPlexWatchlist, removeFromPlexWatchlist } from '../lib/api';
import { reportProblem } from '../lib/notice';

export default function PlexWatchlistButton({ item, size = 'sm' }) {
  const [onList, setOnList] = useState(false);
  const [loading, setLoading] = useState(false);
  const [animating, setAnimating] = useState(false);

  const guid = item?.guid;

  const handleClick = async (e) => {
    e.stopPropagation();
    if (loading || !guid) return;
    setLoading(true);
    setAnimating(true);

    try {
      if (onList) {
        await removeFromPlexWatchlist(guid);
        setOnList(false);
      } else {
        await addToPlexWatchlist(guid);
        setOnList(true);
      }
    } catch (err) {
      reportProblem("Couldn't update your Plex watchlist. Try again.", err);
    } finally {
      setLoading(false);
      setTimeout(() => setAnimating(false), 300);
    }
  };

  if (!guid) return null;

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
          ? 'text-[#E5A00D] hover:text-[#d4920c]'
          : 'text-gray-400 hover:text-[#E5A00D]'
      } hover:bg-black/30 disabled:opacity-50 ${
        animating ? 'scale-125' : 'scale-100'
      }`}
      title={onList ? 'Remove from Plex Watchlist' : 'Add to Plex Watchlist'}
    >
      {/* Plex-style triangle/play icon with + */}
      <svg className={iconSize} viewBox="0 0 24 24" fill={onList ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={onList ? 0 : 2}>
        {onList ? (
          <>
            <polygon points="4,2 20,12 4,22" fill="currentColor" />
          </>
        ) : (
          <>
            <polygon points="4,2 20,12 4,22" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="17" y1="6" x2="17" y2="12" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="14" y1="9" x2="20" y2="9" strokeWidth="2.5" strokeLinecap="round" />
          </>
        )}
      </svg>
    </button>
  );
}
