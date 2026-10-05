import React, { useState, useEffect, useCallback } from 'react';
import { getRandomPick } from '../lib/api';
import RatingBadge from './RatingBadge';
import WatchlistButton from './WatchlistButton';

function Confetti() {
  const [particles] = useState(() =>
    Array.from({ length: 40 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 1.5 + Math.random() * 1.5,
      size: 4 + Math.random() * 6,
      color: ['#f5c518', '#ef4444', '#22c55e', '#3b82f6', '#a855f7', '#f97316'][
        Math.floor(Math.random() * 6)
      ],
      rotation: Math.random() * 360,
    }))
  );

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute animate-confetti-fall"
          style={{
            left: `${p.left}%`,
            top: '-10px',
            width: `${p.size}px`,
            height: `${p.size}px`,
            backgroundColor: p.color,
            borderRadius: Math.random() > 0.5 ? '50%' : '2px',
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            transform: `rotate(${p.rotation}deg)`,
          }}
        />
      ))}
    </div>
  );
}

export default function RandomPick({ serverKey, libraryKey, filters, onClose }) {
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showConfetti, setShowConfetti] = useState(false);

  const fetchRandom = useCallback(async () => {
    if (!serverKey || !libraryKey) return;
    setLoading(true);
    setError(null);
    setShowConfetti(false);

    try {
      const data = await getRandomPick(serverKey, libraryKey, filters);
      setItem(data.item || data);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3000);
    } catch (err) {
      setError(err.message || 'Failed to get a random pick');
    } finally {
      setLoading(false);
    }
  }, [serverKey, libraryKey, filters]);

  useEffect(() => {
    fetchRandom();
  }, [fetchRandom]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const posterUrl = item?.posterUrl || item?.thumb;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/90 backdrop-blur-md" />

      <div
        className="relative w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {showConfetti && <Confetti />}

        {/* Close */}
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 p-2 text-gray-400 hover:text-white transition-colors z-10"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative">
              <div className="w-16 h-16 border-4 border-amber-500/30 rounded-xl animate-spin" />
              <span className="absolute inset-0 flex items-center justify-center text-3xl animate-bounce">
                🎲
              </span>
            </div>
            <p className="text-gray-400 mt-4 text-sm">Rolling the dice...</p>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <p className="text-red-400 mb-4">{error}</p>
            <button
              onClick={fetchRandom}
              className="px-4 py-2 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors text-sm font-medium"
            >
              Try Again
            </button>
          </div>
        ) : item ? (
          <div className="relative bg-surface-800 rounded-2xl overflow-hidden border border-surface-600 shadow-2xl">
            {/* Header label */}
            <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/20 border border-amber-500/30 backdrop-blur-sm">
              <span className="text-base">🎲</span>
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">Your Pick</span>
            </div>

            {/* Poster */}
            {posterUrl && (
              <div className="relative h-80 overflow-hidden">
                <img
                  src={posterUrl}
                  alt={item.title}
                  className="w-full h-full object-cover blur-sm scale-110 opacity-30"
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <img
                    src={posterUrl}
                    alt={item.title}
                    className="h-72 rounded-lg shadow-2xl shadow-black/50 object-contain"
                  />
                </div>
              </div>
            )}

            {/* Content */}
            <div className="p-5 space-y-4">
              <div>
                <h2 className="text-xl font-bold text-gray-100">{item.title}</h2>
                <div className="flex items-center gap-2 mt-1 text-sm text-gray-400">
                  {item.year && <span>{item.year}</span>}
                  {item.duration && (
                    <>
                      <span className="text-gray-600">&bull;</span>
                      <span>{Math.round(item.duration / 60000)} min</span>
                    </>
                  )}
                  {item.contentRating && (
                    <>
                      <span className="text-gray-600">&bull;</span>
                      <span className="px-1.5 py-0.5 rounded text-xs border border-gray-600">
                        {item.contentRating}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Ratings */}
              <div className="flex flex-wrap gap-2">
                {item.imdbRating != null && <RatingBadge value={item.imdbRating} type="imdb" size="md" />}
                {item.rottenTomatoes != null && <RatingBadge value={item.rottenTomatoes} type="rt" size="md" />}
                {item.tmdbRating != null && <RatingBadge value={item.tmdbRating} type="tmdb" size="md" />}
              </div>

              {/* Summary */}
              {item.summary && (
                <p className="text-sm text-gray-400 leading-relaxed line-clamp-4">{item.summary}</p>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <WatchlistButton item={item} size="md" />
                <button
                  onClick={fetchRandom}
                  className="flex-1 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                >
                  <span className="text-base">🎲</span>
                  Pick Again
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
