import React, { useState, useEffect } from 'react';
import { getPersonalRating, rateItemPersonal, removePersonalRating } from '../lib/api';
import { reportProblem } from '../lib/notice';

// `serverKey` is the Plex server the item is on, for items that do not carry
// their own. Thumbs are kept per server: the same item number is a different
// film on another server.
export default function ThumbRating({ item, serverKey, size = 'sm', onRatingChange }) {
  const [rating, setRating] = useState(null); // null, 'up', or 'down'
  const [loading, setLoading] = useState(false);
  const [animatingUp, setAnimatingUp] = useState(false);
  const [animatingDown, setAnimatingDown] = useState(false);

  const plexKey = item?.ratingKey || item?.key;
  const itemServerKey = item?.serverKey || serverKey;

  useEffect(() => {
    if (!plexKey) return;
    let cancelled = false;

    // Check if we have a personalRating already set on the item
    if (item.personalRating) {
      setRating(item.personalRating);
      return;
    }

    getPersonalRating(plexKey, { serverKey: itemServerKey, title: item.title, year: item.year })
      .then((data) => {
        if (cancelled) return;
        setRating(data.rating?.rating || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [plexKey, itemServerKey, item.title, item.year, item.personalRating]);

  const handleRate = async (e, direction) => {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);

    if (direction === 'up') setAnimatingUp(true);
    else setAnimatingDown(true);

    try {
      if (rating === direction) {
        // Toggle off: unrate
        await removePersonalRating(plexKey, { serverKey: itemServerKey, title: item.title, year: item.year });
        setRating(null);
        if (onRatingChange) onRatingChange(plexKey, null, item);
      } else {
        // Set new rating
        await rateItemPersonal({
          plexKey: String(plexKey),
          serverKey: itemServerKey,
          title: item.title,
          year: item.year,
          type: item.type,
          guid: item.guid,
          genres: item.genres,
          rating: direction,
        });
        setRating(direction);
        if (onRatingChange) onRatingChange(plexKey, direction, item);
      }
    } catch (err) {
      reportProblem("That rating didn't save. Try again.", err);
    } finally {
      setLoading(false);
      setTimeout(() => {
        setAnimatingUp(false);
        setAnimatingDown(false);
      }, 300);
    }
  };

  const isSmall = size === 'sm';
  const btnClasses = isSmall ? 'p-0.5 rounded' : 'p-1.5 rounded-lg';
  const iconSize = isSmall ? 'w-3.5 h-3.5' : 'w-5 h-5';

  return (
    <div className="flex items-center gap-0.5">
      {/* Thumbs up */}
      <button
        onClick={(e) => handleRate(e, 'up')}
        disabled={loading}
        className={`${btnClasses} transition-all duration-200 ${
          rating === 'up'
            ? 'text-[#22C55E] hover:text-[#16A34A]'
            : 'text-gray-500 hover:text-[#22C55E]'
        } hover:bg-black/30 disabled:opacity-50 ${
          animatingUp ? 'scale-125' : 'scale-100'
        }`}
        title="Thumbs Up"
      >
        <svg className={iconSize} viewBox="0 0 24 24" fill={rating === 'up' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={rating === 'up' ? 0 : 2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
        </svg>
      </button>

      {/* Thumbs down */}
      <button
        onClick={(e) => handleRate(e, 'down')}
        disabled={loading}
        className={`${btnClasses} transition-all duration-200 ${
          rating === 'down'
            ? 'text-[#EF4444] hover:text-[#DC2626]'
            : 'text-gray-500 hover:text-[#EF4444]'
        } hover:bg-black/30 disabled:opacity-50 ${
          animatingDown ? 'scale-125' : 'scale-100'
        }`}
        title="Thumbs Down"
      >
        <svg className={iconSize} viewBox="0 0 24 24" fill={rating === 'down' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={rating === 'down' ? 0 : 2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10zM17 2h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17" />
        </svg>
      </button>
    </div>
  );
}
