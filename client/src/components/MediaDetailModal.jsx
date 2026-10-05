import React, { useEffect, useState, useCallback } from 'react';
import RatingBadge from './RatingBadge';
import SimilarPanel from './SimilarPanel';
import StreamingBadges from './StreamingBadges';
import WatchlistButton from './WatchlistButton';
import PlexWatchlistButton from './PlexWatchlistButton';
import QueueButton from './QueueButton';
import ThumbRating from './ThumbRating';
import TrailerButton from './TrailerButton';
import QualityBadge from './QualityBadge';
import DownloadButton from './DownloadButton';
import SubscribeButton from './SubscribeButton';
import NotInterestedButton from './NotInterestedButton';

export default function MediaDetailModal({ item, onClose, items, currentIndex, onNavigate, serverKey, onPlayOnTv }) {
  const [showSimilar, setShowSimilar] = useState(false);
  const [cast, setCast] = useState(null);

  // Fetch cast on open / when navigating to a new item
  useEffect(() => {
    let cancelled = false;
    setCast(null);
    if (!item.tmdbId) return;
    fetch(`/api/cast/${item.type === 'show' ? 'show' : 'movie'}/${item.tmdbId}`)
      .then((r) => (r.ok ? r.json() : { cast: [] }))
      .then((data) => { if (!cancelled) setCast(data.cast || []); })
      .catch(() => { if (!cancelled) setCast([]); });
    return () => { cancelled = true; };
  }, [item.tmdbId, item.type]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowLeft' && items && currentIndex > 0 && onNavigate) {
      onNavigate(currentIndex - 1);
    } else if (e.key === 'ArrowRight' && items && currentIndex < items.length - 1 && onNavigate) {
      onNavigate(currentIndex + 1);
    }
  }, [onClose, items, currentIndex, onNavigate]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [handleKeyDown]);

  const posterUrl = item.posterUrl || item.thumb;
  const genres = item.genres || [];
  const hasNavigation = items && items.length > 1 && onNavigate;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      {/* Navigation arrows */}
      {hasNavigation && currentIndex > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate(currentIndex - 1); }}
          className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 z-[51] p-2 rounded-full bg-black/60 hover:bg-black/80 text-gray-300 hover:text-white transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}
      {hasNavigation && currentIndex < items.length - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate(currentIndex + 1); }}
          className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 z-[51] p-2 rounded-full bg-black/60 hover:bg-black/80 text-gray-300 hover:text-white transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* Modal */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-lg max-h-[90vh] overflow-y-auto bg-surface-800 rounded-t-2xl sm:rounded-2xl border border-surface-700 shadow-2xl"
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1.5 rounded-full bg-black/50 hover:bg-black/70 transition-smooth"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Hero area: backdrop + clearlogo when available, else blurred poster */}
        <div className="relative">
          {item.backdropUrl ? (
            <div className="relative h-64 sm:h-80 overflow-hidden rounded-t-2xl">
              <img
                src={item.backdropUrl}
                alt={item.title}
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-surface-800 via-surface-800/60 to-transparent" />
              {item.clearlogoUrl && (
                <div className="absolute inset-x-0 bottom-4 flex items-end justify-center px-6">
                  <img
                    src={item.clearlogoUrl}
                    alt={item.title}
                    className="max-h-24 sm:max-h-28 max-w-[80%] object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.8)]"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                </div>
              )}
            </div>
          ) : posterUrl ? (
            <div className="relative h-64 sm:h-72 overflow-hidden rounded-t-2xl">
              <img
                src={posterUrl}
                alt={item.title}
                className="w-full h-full object-cover blur-sm scale-110 opacity-40"
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <img
                  src={posterUrl}
                  alt={item.title}
                  className="h-56 sm:h-64 rounded-lg shadow-2xl object-contain"
                />
              </div>
            </div>
          ) : (
            <div className="h-40 bg-surface-700 rounded-t-2xl flex items-center justify-center">
              <svg className="w-16 h-16 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
              </svg>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Title & year (title hidden when clearlogo already in hero) */}
          <div>
            {!(item.backdropUrl && item.clearlogoUrl) && (
              <h2 className="text-xl font-bold text-gray-100">{item.title}</h2>
            )}
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

          {/* Quality info */}
          {(item.resolution || item.hdr || item.audioCodec) && (
            <QualityBadge resolution={item.resolution} hdr={item.hdr} audioCodec={item.audioCodec} />
          )}

          {/* Ratings */}
          <div className="flex flex-wrap gap-2">
            {item.imdbRating != null && (
              <RatingBadge
                value={item.imdbRating}
                type="imdb"
                size="md"
                voteCount={item.imdbVoteCount}
                lowConfidence={(item.imdbVoteCount == null && item.imdbRating >= 8.5) || (item.imdbVoteCount != null && item.imdbVoteCount < 100)}
              />
            )}
            {item.rottenTomatoes != null && (
              <RatingBadge value={item.rottenTomatoes} type="rt" size="md" />
            )}
            {item.rtAudienceScore != null && (
              <RatingBadge value={item.rtAudienceScore} type="rtAudience" size="md" />
            )}
            {(item.tmdbRating != null || item.rawTmdbRating != null) && (
              <RatingBadge
                value={item.tmdbRating ?? item.rawTmdbRating}
                type="tmdb"
                size="md"
                voteCount={item.tmdbVoteCount}
                lowConfidence={item.tmdbRatingLowConfidence}
              />
            )}
            {item.metacritic != null && (
              <RatingBadge value={item.metacritic} type="metacritic" size="md" />
            )}
            {item.letterboxdRating != null && (
              <RatingBadge value={item.letterboxdRating} type="letterboxd" size="md" />
            )}
            {item.traktRating != null && (
              <RatingBadge value={item.traktRating} type="trakt" size="md" />
            )}
            {item.mdblistScore != null && (
              <RatingBadge value={item.mdblistScore} type="mdblist" size="md" />
            )}
          </div>

          {/* Subscription services that also carry it, with the JustWatch credit */}
          <StreamingBadges item={item} size="md" max={8} credit />

          {/* Summary */}
          {item.summary && (
            <p className="text-sm text-gray-300 leading-relaxed">{item.summary}</p>
          )}

          {/* Cast row */}
          {cast && cast.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Cast</div>
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin">
                {cast.map((c, i) => (
                  <div key={`${c.name}-${i}`} className="flex-shrink-0 w-20 text-center">
                    {c.profileUrl ? (
                      <img
                        src={c.profileUrl}
                        alt={c.name}
                        loading="lazy"
                        className="w-20 h-20 rounded-full object-cover bg-surface-700"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-surface-700 flex items-center justify-center text-gray-500 text-xl">
                        {c.name?.charAt(0) ?? '?'}
                      </div>
                    )}
                    <div className="mt-1.5 text-[11px] text-gray-200 leading-tight line-clamp-2">{c.name}</div>
                    {c.character && (
                      <div className="text-[10px] text-gray-500 leading-tight line-clamp-2">{c.character}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Genres */}
          {genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {genres.map((g) => (
                <span
                  key={g}
                  className="px-2.5 py-1 rounded-full text-xs bg-surface-700 text-gray-400 border border-surface-600"
                >
                  {g}
                </span>
              ))}
            </div>
          )}

          {/* Extra details */}
          <div className="space-y-2 text-sm">
            {item.studio && (
              <div className="flex">
                <span className="text-gray-500 w-20 shrink-0">Studio</span>
                <span className="text-gray-300">{item.studio}</span>
              </div>
            )}
            {item.director && (
              <div className="flex">
                <span className="text-gray-500 w-20 shrink-0">Director</span>
                <span className="text-gray-300">{item.director}</span>
              </div>
            )}
            {item.actors && item.actors.length > 0 && (
              <div className="flex">
                <span className="text-gray-500 w-20 shrink-0">Cast</span>
                <span className="text-gray-300">{item.actors.slice(0, 5).join(', ')}</span>
              </div>
            )}
          </div>

          {/* Personal Rating */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 uppercase tracking-wide">Your Rating</span>
            <ThumbRating item={item} serverKey={serverKey} size="md" />
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 flex-wrap">
            {onPlayOnTv && (
              <button
                onClick={() => onPlayOnTv(item)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-black text-sm font-bold hover:brightness-110 transition-smooth"
                title="Send this to the TV"
              >
                <span className="text-base">📺</span>
                Play on TV
              </button>
            )}
            <WatchlistButton item={item} size="md" />
            <PlexWatchlistButton item={item} size="md" />
            <QueueButton item={item} size="md" />
            <TrailerButton tmdbId={item.tmdbId} type={item.type} size="md" />
            <DownloadButton item={item} serverKey={serverKey} size="md" />
            {item.type === 'show' && <SubscribeButton item={item} size="md" />}
            <NotInterestedButton item={item} serverKey={serverKey} compact />
          </div>

          {/* Find Similar — full width, prominent */}
          <button
            onClick={() => setShowSimilar(true)}
            className="w-full py-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors text-sm font-semibold flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            Find Similar
          </button>

          {/* Navigation hint */}
          {hasNavigation && (
            <p className="text-center text-[10px] text-gray-600">
              Use left/right arrow keys to navigate
            </p>
          )}
        </div>
      </div>

      {/* Similar panel overlay */}
      {showSimilar && (
        <SimilarPanel item={item} onClose={() => setShowSimilar(false)} />
      )}
    </div>
  );
}
