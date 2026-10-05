import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getProviders, getStreamingCatalog, matchAgainstLibraries } from '../lib/api';
import RatingBadge from './RatingBadge';

const SORTS = [
  { value: 'popularity.desc', label: 'Popular' },
  { value: 'vote_average.desc', label: 'Top Rated' },
  { value: 'primary_release_date.desc', label: 'Newest' },
];

const TV_SORTS = [
  { value: 'popularity.desc', label: 'Popular' },
  { value: 'vote_average.desc', label: 'Top Rated' },
  { value: 'first_air_date.desc', label: 'Newest' },
];

const RATING_FLOORS = [
  { value: '', label: 'Any' },
  { value: '6', label: '6+' },
  { value: '7', label: '7+' },
  { value: '8', label: '8+' },
];

const HOVER_TRAILER_DELAY_MS = 1200;

function StreamCard({ item, owned, onPlayOnTv }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [trailerKey, setTrailerKey] = useState(null);
  const [showTrailer, setShowTrailer] = useState(false);
  const hoverTimerRef = useRef(null);
  const trailerFetchedRef = useRef(false);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const handleMouseEnter = () => {
    if (!item.tmdbId) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(async () => {
      if (!trailerFetchedRef.current) {
        trailerFetchedRef.current = true;
        try {
          const mediaType = item.mediaType === 'tv' ? 'show' : 'movie';
          const res = await fetch(`/api/trailer/${mediaType}/${item.tmdbId}`);
          if (res.ok) {
            const data = await res.json();
            if (data.key) setTrailerKey(data.key);
          }
        } catch { /* trailer is a nicety, never block the card */ }
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
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="group relative rounded-xl overflow-hidden bg-surface-850 border border-white/5 hover:border-amber-400/40 hover:scale-[1.04] hover:z-10 transition-all duration-300 ease-out hover:shadow-2xl hover:shadow-black/50"
    >
      <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
        {!imgError && item.posterUrl ? (
          <>
            {!imgLoaded && <div className="absolute inset-0 animate-pulse bg-surface-700" />}
            <img
              src={item.posterUrl}
              alt={item.title}
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
              className={`w-full h-full object-cover transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
          </>
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-surface-700 via-surface-800 to-surface-850 flex flex-col items-center justify-center p-3 text-center">
            <span className="text-3xl mb-2 opacity-40">🎬</span>
            <span className="text-xs font-semibold text-gray-200 line-clamp-3 leading-tight">{item.title}</span>
          </div>
        )}

        {showTrailer && trailerKey && (
          <div className="absolute inset-0 z-20 bg-black pointer-events-none">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailerKey}&modestbranding=1&playsinline=1&rel=0`}
              title={`${item.title} trailer`}
              allow="autoplay; encrypted-media; picture-in-picture"
              className="absolute inset-0 w-full h-full"
              frameBorder="0"
            />
          </div>
        )}

        {owned && (
          <span className="absolute top-2 right-2 z-10 px-1.5 py-0.5 rounded text-[9px] font-bold bg-accent text-black shadow-lg">
            YOU HAVE THIS
          </span>
        )}

        {item.onProvider && (
          <span
            className="absolute top-2 left-2 z-10 px-1.5 py-0.5 rounded text-[9px] font-bold text-white shadow-lg"
            style={{ backgroundColor: item.onProvider.color }}
          >
            {item.onProvider.name}
          </span>
        )}

        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
          <div className="flex items-center justify-between gap-1">
            {item.tmdbRating != null && <RatingBadge value={item.tmdbRating} type="tmdb" size="sm" />}
            {owned ? (
              <button
                onClick={(e) => { e.stopPropagation(); onPlayOnTv && onPlayOnTv(owned); }}
                className="px-2 py-0.5 rounded text-[10px] font-bold bg-accent text-black opacity-0 group-hover:opacity-100 transition-opacity hover:brightness-110"
                title="You already have this — play it on the TV"
              >
                📺 Play
              </button>
            ) : (
              <a
                href={item.watchUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="px-2 py-0.5 rounded text-[10px] font-semibold bg-white/90 text-black opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white"
              >
                Watch
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="p-2">
        <h4 className="text-xs font-semibold text-gray-100 truncate" title={item.title}>{item.title}</h4>
        <span className="text-[10px] text-gray-500">{item.year || ''}</span>
      </div>
    </div>
  );
}

/**
 * Browse a streaming service's catalogue the same way you browse a Plex
 * library. The point is that "what should we watch" gets answered in one place
 * instead of bouncing between four apps.
 */
export default function StreamingBrowse({ onClose, initialProvider = 'netflix', onPlayOnTv }) {
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState(initialProvider);
  const [type, setType] = useState('movie');
  const [sortBy, setSortBy] = useState('popularity.desc');
  const [minRating, setMinRating] = useState('');
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [owned, setOwned] = useState({});
  const [librariesSearched, setLibrariesSearched] = useState(null);

  useEffect(() => {
    getProviders()
      .then((d) => setProviders(d.providers || []))
      .catch(() => setProviders([]));
  }, []);

  // Which catalogue is on screen. Every answer is checked against it when it
  // lands: switching from Netflix to Hulu while Netflix was still answering
  // used to paint Netflix's titles under the Hulu heading, or append them to
  // Hulu's list via "load more".
  const generation = useRef(0);

  const load = useCallback(async (targetPage, replace) => {
    if (replace) generation.current += 1;
    const mine = generation.current;
    const stillCurrent = () => mine === generation.current;
    setLoading(true);
    setError('');
    try {
      const data = await getStreamingCatalog(provider, {
        type,
        page: targetPage,
        sortBy,
        minRating,
      });
      if (!stillCurrent()) return;
      setTotalPages(data.totalPages || 1);
      setItems((prev) => {
        if (replace) return data.results;
        // TMDB pages shift while you scroll, so a title can come back on the
        // next page as well; showing it twice breaks the list's keys.
        const seen = new Set(prev.map((r) => `${r.mediaType}:${r.tmdbId}`));
        return [...prev, ...data.results.filter((r) => !seen.has(`${r.mediaType}:${r.tmdbId}`))];
      });
      setPage(data.page || targetPage);

      // Owning a copy beats sending anyone off to Netflix, so check every
      // result against the libraries before offering an external link.
      matchAgainstLibraries(
        data.results.map((r) => ({ tmdbId: r.tmdbId, title: r.title, year: r.year, type: r.mediaType }))
      )
        .then((m) => {
          if (!stillCurrent()) return;
          setLibrariesSearched(m.librariesSearched);
          setOwned((prev) => (replace ? m.matches || {} : { ...prev, ...(m.matches || {}) }));
        })
        .catch(() => { /* matching is a bonus; the catalogue still works without it */ });
    } catch (err) {
      if (!stillCurrent()) return;
      setError(err.message);
      if (replace) setItems([]);
    } finally {
      if (stillCurrent()) setLoading(false);
    }
  }, [provider, type, sortBy, minRating]);

  // Films and series sort by different fields. A film-only sort carried over
  // to the TV tab was ignored by TMDB while the menu still showed it chosen.
  useEffect(() => {
    const valid = (type === 'tv' ? TV_SORTS : SORTS).some((option) => option.value === sortBy);
    if (!valid) setSortBy('popularity.desc');
  }, [type, sortBy]);

  useEffect(() => {
    load(1, true);
  }, [load]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const activeProvider = providers.find((p) => p.slug === provider);
  const sorts = type === 'tv' ? TV_SORTS : SORTS;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 glass">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-2xl">📺</span>
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold text-gray-100 truncate">
              On {activeProvider?.name || 'Streaming'}
            </h2>
            <p className="text-xs text-gray-500">
              {librariesSearched === 0
                ? 'Still reading your libraries — "you already have this" is not ready yet.'
                : 'Anything you already have is marked and plays straight to the TV.'}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-surface-700 transition-smooth"
          title="Close (Esc)"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Service tabs */}
      <div className="flex gap-1.5 overflow-x-auto px-4 py-2 border-b border-white/5 no-scrollbar">
        {providers.map((p) => (
          <button
            key={p.slug}
            onClick={() => setProvider(p.slug)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-smooth ${
              p.slug === provider ? 'text-white shadow-lg' : 'bg-surface-800 text-gray-400 hover:text-gray-200'
            }`}
            style={p.slug === provider ? { backgroundColor: p.color } : undefined}
          >
            {p.name}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-white/5">
        <div className="flex rounded-lg overflow-hidden border border-surface-600">
          {[{ v: 'movie', l: 'Movies' }, { v: 'tv', l: 'TV' }].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setType(opt.v)}
              className={`px-3 py-1.5 text-xs font-semibold transition-smooth ${
                type === opt.v ? 'bg-accent text-black' : 'bg-surface-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {opt.l}
            </button>
          ))}
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="px-2.5 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-xs text-gray-100 focus:outline-none focus:border-accent"
        >
          {sorts.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">Rating</span>
          {RATING_FLOORS.map((r) => (
            <button
              key={r.value || 'any'}
              onClick={() => setMinRating(r.value)}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition-smooth ${
                minRating === r.value ? 'bg-accent text-black' : 'bg-surface-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* TMDB's "what is on each service" data comes from JustWatch, and
            naming them where it shows is a condition of using it. */}
        <a
          href="https://www.justwatch.com"
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-[10px] text-gray-500 hover:text-gray-300 transition-smooth"
        >
          Streaming availability by JustWatch
        </a>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
            {error}
          </div>
        )}

        {items.length === 0 && loading && (
          <div className="text-center text-gray-500 py-16 text-sm">Loading…</div>
        )}

        {items.length === 0 && !loading && !error && (
          <div className="text-center text-gray-500 py-16 text-sm">
            Nothing matched. Try a lower rating floor.
          </div>
        )}

        {/* Same density as the library grid — a different poster size between
            the two screens reads as a bug, not a design choice. */}
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5 sm:gap-3">
          {items.map((item) => (
            <StreamCard
              key={`${item.mediaType}:${item.tmdbId}`}
              item={item}
              owned={owned[`${item.mediaType}:${item.tmdbId}`]}
              onPlayOnTv={onPlayOnTv}
            />
          ))}
        </div>

        {page < totalPages && (
          <div className="flex justify-center py-6">
            <button
              onClick={() => load(page + 1, false)}
              disabled={loading}
              className="px-5 py-2.5 rounded-lg bg-surface-800 border border-surface-600 text-sm font-semibold text-gray-200 hover:bg-surface-700 disabled:opacity-50 transition-smooth"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
