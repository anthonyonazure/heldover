import React, { useRef, useState } from 'react';
import { getTrailer } from '../lib/api';

export default function TrailerButton({ tmdbId, type, size = 'sm', full = false }) {
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [trailerUrl, setTrailerUrl] = useState(null);
  const [noTrailer, setNoTrailer] = useState(false);
  const playerRef = useRef(null);

  // Ask the browser to take the player full screen. On a phone the reliable
  // route is the player's own control once the video is playing, so this is an
  // additional way in rather than the only one, and it stays quiet if the
  // browser refuses.
  const goFullscreen = () => {
    const el = playerRef.current;
    if (!el) return;
    const request = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitEnterFullscreen;
    if (request) {
      Promise.resolve(request.call(el)).catch(() => {});
    }
  };

  const handleClick = async (e) => {
    e.stopPropagation();
    if (!tmdbId || loading) return;

    setLoading(true);
    try {
      const data = await getTrailer(tmdbId, type || 'movie');
      // The server answers with `trailerUrl`. This read for `url` and `key`,
      // neither of which it has ever sent, so every title in the app reported
      // "No trailer available" no matter what TMDB actually had.
      const found = data.trailerUrl || data.url || data.key;
      if (found) {
        const embedUrl = found.startsWith('http')
          ? found.replace('www.youtube.com', 'www.youtube-nocookie.com').replace('watch?v=', 'embed/') + (found.includes('watch?v=') ? '?autoplay=1&rel=0' : '')
          : `https://www.youtube-nocookie.com/embed/${found}?autoplay=1&rel=0`;
        setTrailerUrl(embedUrl);
        setShowModal(true);
      } else {
        setNoTrailer(true);
        setTimeout(() => setNoTrailer(false), 2000);
      }
    } catch {
      setNoTrailer(true);
      setTimeout(() => setNoTrailer(false), 2000);
    } finally {
      setLoading(false);
    }
  };

  const sizeClasses = size === 'md'
    ? 'px-3 py-2 rounded-lg text-sm gap-2'
    : 'p-1 rounded';

  // `full` is for somewhere the trailer is one of the choices being offered
  // rather than a small extra on a card, so it looks like the button it is.
  const layout = full ? 'w-full justify-center' : '';
  const emphasis = full
    ? 'bg-surface-800 hover:bg-surface-700 border border-surface-700 font-semibold text-gray-100 hover:text-white'
    : '';

  const iconSize = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5';

  if (!tmdbId) return null;

  return (
    <>
      <button
        onClick={handleClick}
        disabled={loading || noTrailer}
        className={`inline-flex items-center transition-all duration-200 ${sizeClasses} ${layout} ${
          noTrailer
            ? 'text-gray-600 cursor-not-allowed'
            : emphasis || 'text-gray-400 hover:text-white hover:bg-white/10'
        } disabled:opacity-50`}
        title={noTrailer ? 'No trailer available' : 'Watch Trailer'}
      >
        {loading ? (
          <svg className={`${iconSize} animate-spin`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" className="opacity-25" />
            <path d="M4 12a8 8 0 018-8" className="opacity-75" />
          </svg>
        ) : (
          <svg className={iconSize} viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
        {(size === 'md' || full) && <span>{noTrailer ? 'No trailer found' : 'Watch trailer'}</span>}
      </button>

      {/* Trailer Modal */}
      {showModal && trailerUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          onClick={() => setShowModal(false)}
        >
          <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-4xl mx-2 sm:mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute -top-10 right-0 flex items-center gap-1">
              <button
                onClick={goFullscreen}
                className="p-2 text-gray-400 hover:text-white transition-colors"
                title="Full screen"
                aria-label="Play trailer full screen"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4" />
                </svg>
              </button>
              <button
                onClick={() => setShowModal(false)}
                className="p-2 text-gray-400 hover:text-white transition-colors"
                title="Close"
                aria-label="Close trailer"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div
              ref={playerRef}
              className="relative w-full bg-black rounded-lg overflow-hidden"
              style={{ paddingBottom: '56.25%' }}
            >
              {/*
                `fullscreen` has to be named in the allow list. The
                `allowFullScreen` attribute alone is the older spelling, and
                once an `allow` list is present some browsers treat that list as
                the whole truth, so the player's own expand button did nothing.
              */}
              <iframe
                src={trailerUrl}
                className="absolute inset-0 w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
                title="Trailer"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
