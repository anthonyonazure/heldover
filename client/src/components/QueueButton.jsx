import React, { useState, useEffect } from 'react';
import { checkQueue, addToQueue, removeFromQueue, getQueueItems } from '../lib/api';
import { reportProblem } from '../lib/notice';

export default function QueueButton({ item, size = 'sm' }) {
  const [inQueue, setInQueue] = useState(false);
  const [queueId, setQueueId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [animating, setAnimating] = useState(false);

  const plexKey = item?.ratingKey || item?.key;

  useEffect(() => {
    if (!plexKey) return;
    let cancelled = false;
    checkQueue(plexKey)
      .then((data) => {
        if (cancelled) return;
        setInQueue(!!data.inQueue);
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
      if (inQueue) {
        // Need to find the queue item ID first
        const queueData = await getQueueItems();
        const queueItems = queueData.items || [];
        const match = queueItems.find((q) => q.plex_key === String(plexKey));
        if (match) {
          await removeFromQueue(match.id);
        }
        setInQueue(false);
        setQueueId(null);
      } else {
        const result = await addToQueue({
          plexKey: String(plexKey),
          title: item.title,
          year: item.year,
          type: item.type,
          guid: item.guid,
          thumb: item.posterUrl || item.thumb,
          imdbRating: item.imdbRating,
          rottenTomatoes: item.rottenTomatoes,
          genres: item.genres,
          serverKey: item.serverKey,
          libraryKey: item.libraryKey,
        });
        setInQueue(true);
        setQueueId(result.item?.id || null);
      }
    } catch (err) {
      reportProblem("Couldn't update your queue. Try again.", err);
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
        inQueue
          ? 'text-[#06B6D4] hover:text-[#0891B2]'
          : 'text-gray-400 hover:text-[#06B6D4]'
      } hover:bg-black/30 disabled:opacity-50 ${
        animating ? 'scale-125' : 'scale-100'
      }`}
      title={inQueue ? 'Remove from Queue' : 'Add to Watch Later Queue'}
    >
      {/* Clock icon */}
      <svg className={iconSize} viewBox="0 0 24 24" fill={inQueue ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={inQueue ? 0 : 2}>
        {inQueue ? (
          <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 4a1 1 0 011 1v4.586l2.707 2.707a1 1 0 01-1.414 1.414l-3-3A1 1 0 0111 12V7a1 1 0 011-1z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
      </svg>
    </button>
  );
}
