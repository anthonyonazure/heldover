import React, { useState, useRef, useEffect } from 'react';
import RatingBadge from './RatingBadge';
import WatchlistButton from './WatchlistButton';
import QualityBadge from './QualityBadge';
import TrailerButton from './TrailerButton';
import DownloadButton from './DownloadButton';
import ThumbRating from './ThumbRating';
import SubscribeButton from './SubscribeButton';
import StreamingBadges from './StreamingBadges';

function isNewlyAdded(item) {
  if (!item.addedAt) return false;
  const addedTime = typeof item.addedAt === 'number'
    ? item.addedAt * 1000 // Unix seconds to ms
    : new Date(item.addedAt).getTime();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return addedTime > sevenDaysAgo;
}

const HOVER_TRAILER_DELAY_MS = 1500;

export default function MediaCard({ item, onClick, serverKey, onRatingChange }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [trailerKey, setTrailerKey] = useState(null); // YouTube key, null until loaded
  const [showTrailer, setShowTrailer] = useState(false);
  const hoverTimerRef = useRef(null);
  const trailerFetchedRef = useRef(false);

  const posterUrl = item.posterUrl || item.thumb || item.backdropUrl;
  const year = item.year;
  const title = item.title;
  const genres = item.genres || [];
  const contentRating = item.contentRating;
  const actors = item.actors || [];
  const isNew = isNewlyAdded(item);
  const isDisliked = item.personalRating === 'down';

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const handleMouseEnter = () => {
    if (!item.tmdbId) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(async () => {
      if (!trailerFetchedRef.current) {
        trailerFetchedRef.current = true;
        try {
          const mediaType = item.type === 'show' ? 'show' : 'movie';
          const res = await fetch(`/api/trailer/${mediaType}/${item.tmdbId}`);
          if (res.ok) {
            const data = await res.json();
            if (data.key) setTrailerKey(data.key);
          }
        } catch { /* ignore */ }
      }
      setShowTrailer(true);
    }, HOVER_TRAILER_DELAY_MS);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setShowTrailer(false);
  };

  return (
    <div
      onClick={() => onClick(item)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`group relative cursor-pointer rounded-xl overflow-hidden bg-surface-850 border border-white/5 hover:border-amber-400/40 hover:scale-[1.04] hover:z-10 transition-all duration-300 ease-out hover:shadow-2xl hover:shadow-black/50 ${isDisliked ? 'opacity-50' : ''}`}
    >
      {/* Poster */}
      <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
        {!imgError && posterUrl ? (
          <>
            {!imgLoaded && (
              <div className="absolute inset-0 animate-pulse bg-surface-700" />
            )}
            <img
              src={posterUrl}
              alt={title}
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
              className={`w-full h-full object-cover transition-opacity duration-300 ${
                imgLoaded ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </>
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-surface-700 via-surface-800 to-surface-850 flex flex-col items-center justify-center p-3 text-center">
            <span className="text-3xl mb-2 opacity-40">🎬</span>
            <span className="text-xs font-semibold text-gray-200 line-clamp-3 leading-tight">{title}</span>
            {year && <span className="text-[10px] text-gray-500 mt-1">{year}</span>}
          </div>
        )}

        {/* Trailer overlay (hover-with-delay → muted YT autoplay) */}
        {showTrailer && trailerKey && (
          <div className="absolute inset-0 z-20 bg-black pointer-events-none">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailerKey}&modestbranding=1&playsinline=1&rel=0`}
              title={`${title} trailer`}
              allow="autoplay; encrypted-media; picture-in-picture"
              className="absolute inset-0 w-full h-full"
              frameBorder="0"
            />
          </div>
        )}

        {/* NEW badge */}
        {isNew && (
          <span className="absolute top-2 left-2 z-10 px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-500 text-white shadow-lg shadow-green-500/30">
            NEW
          </span>
        )}

        {/* Content rating badge */}
        {contentRating && (
          <span className={`absolute ${isNew ? 'top-8' : 'top-2'} left-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-black/70 text-gray-300 border border-gray-600`}>
            {contentRating}
          </span>
        )}

        {/* Watchlist button (top-right) */}
        <div className="absolute top-1 right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <WatchlistButton item={item} size="sm" />
        </div>

        {/* Download button (below watchlist, top-right) */}
        {serverKey && (
          <div className="absolute top-8 right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <DownloadButton item={item} serverKey={serverKey} size="sm" />
          </div>
        )}

        {/* Subscribe button for shows (below download, top-right) */}
        {item.type === 'show' && (
          <div className={`absolute ${serverKey ? 'top-[60px]' : 'top-8'} right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200`}>
            <SubscribeButton item={item} size="sm" />
          </div>
        )}

        {/* Thumb rating (bottom-left, on hover) */}
        <div className="absolute bottom-8 left-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <ThumbRating item={item} serverKey={serverKey} size="sm" onRatingChange={onRatingChange} />
        </div>

        {/* Quality badges (bottom-right, above rating row) */}
        {(item.resolution || item.hdr || item.audioCodec) && (
          <div className="absolute top-2 right-8 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <QualityBadge resolution={item.resolution} hdr={item.hdr} audioCodec={item.audioCodec} />
          </div>
        )}

        {/* Rating badges overlay */}
        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
          <StreamingBadges item={item} size="xs" className="mb-1" />
          <div className="flex gap-1 flex-wrap items-center">
            {item.imdbRating != null && (
              <RatingBadge
                value={item.imdbRating}
                type="imdb"
                size="sm"
                voteCount={item.imdbVoteCount}
                lowConfidence={(item.imdbVoteCount == null && item.imdbRating >= 8.5) || (item.imdbVoteCount != null && item.imdbVoteCount < 100)}
              />
            )}
            {item.rottenTomatoes != null && <RatingBadge value={item.rottenTomatoes} type="rt" size="sm" />}
            {item.rtAudienceScore != null && <RatingBadge value={item.rtAudienceScore} type="rtAudience" size="sm" />}
            {item.metacritic != null && <RatingBadge value={item.metacritic} type="metacritic" size="sm" />}
            {item.letterboxdRating != null && <RatingBadge value={item.letterboxdRating} type="letterboxd" size="sm" />}
            {item.traktRating != null && <RatingBadge value={item.traktRating} type="trakt" size="sm" />}
            {item.tmdbRating != null && (
              <RatingBadge value={item.tmdbRating} type="tmdb" size="sm" voteCount={item.tmdbVoteCount} />
            )}
            {item.mdblistScore != null && <RatingBadge value={item.mdblistScore} type="mdblist" size="sm" />}
            {item.tmdbId && (
              <div className="ml-auto">
                <TrailerButton tmdbId={item.tmdbId} type={item.type} size="sm" />
              </div>
            )}
          </div>
        </div>

        {/* Hover overlay with summary */}
        <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity duration-300 p-3 flex flex-col justify-end pointer-events-none hidden md:flex">
          {item.summary && (
            <p className="text-xs text-gray-300 line-clamp-6 leading-relaxed">
              {item.summary}
            </p>
          )}
        </div>
      </div>

      {/* Info below poster */}
      <div className="p-2.5">
        {item.clearlogoUrl ? (
          <div className="h-7 flex items-center" title={title}>
            <img
              src={item.clearlogoUrl}
              alt={title}
              loading="lazy"
              className="max-h-7 max-w-full object-contain object-left"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </div>
        ) : (
          <h3 className="text-sm font-semibold text-gray-100 truncate leading-tight" title={title}>
            {title}
          </h3>
        )}
        <div className="flex items-center gap-2 mt-1">
          {year && <span className="text-xs text-gray-500">{year}</span>}
          {item.duration && (
            <span className="text-xs text-gray-600">{Math.round(item.duration / 60000)}m</span>
          )}
        </div>
        {genres.length > 0 && (
          <div className="flex gap-1 mt-1.5 overflow-hidden">
            {genres.slice(0, 2).map((g) => (
              <span
                key={g}
                className="px-1.5 py-0.5 rounded text-[9px] bg-surface-700 text-gray-500 truncate"
              >
                {g}
              </span>
            ))}
            {genres.length > 2 && (
              <span className="text-[9px] text-gray-600 self-center">+{genres.length - 2}</span>
            )}
          </div>
        )}
        {/* Actor names (first 2) */}
        {actors.length > 0 && (
          <p className="text-[10px] text-gray-600 mt-1 truncate">
            {actors.slice(0, 2).join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}
