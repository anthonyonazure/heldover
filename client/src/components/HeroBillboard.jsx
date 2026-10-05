import React, { useState, useMemo, useEffect } from 'react';

/**
 * Netflix-style hero billboard. Picks one cinematic-feeling item from the
 * current library — top-rated + backdrop available + unwatched — and shows it
 * full-width with a backdrop, fade-to-bottom gradient, large title, synopsis,
 * and primary CTAs. Refreshes when the underlying items array changes.
 */
function pickHero(items) {
  if (!items || items.length === 0) return null;

  // Rotate based on the current day-of-year so the same person sees the same
  // billboard for the day, but it shifts overnight.
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const todays = (pool) => pool[dayOfYear % pool.length];
  const worthFeaturing = (it) => Math.max(it.imdbRating || 0, it.tmdbRating || 0) >= 7.2 && (it.viewCount || 0) === 0;

  const withBackdrop = items.filter((it) => it.backdropUrl);
  const best = withBackdrop.filter(worthFeaturing);
  if (best.length >= 5) return todays(best);
  if (withBackdrop.length > 0) return todays(withBackdrop);

  // No title here has a wide backdrop. They come from Fanart.tv, which needs
  // its own key, so a library can have none at all. The billboard used to
  // show the first title with an empty black banner; it now picks the same
  // way among titles that have a poster, and draws the poster instead.
  const withPoster = items.filter((it) => it.posterUrl || it.thumb);
  const bestWithPoster = withPoster.filter(worthFeaturing);
  if (bestWithPoster.length >= 5) return todays(bestWithPoster);
  if (withPoster.length > 0) return todays(withPoster);
  return items[0];
}

function formatRuntime(ms) {
  if (!ms) return null;
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export default function HeroBillboard({ items, onPlay, onMoreInfo }) {
  const hero = useMemo(() => pickHero(items), [items]);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    setImgLoaded(false);
  }, [hero?.ratingKey]);

  if (!hero) return null;

  const backdrop = hero.backdropUrl;
  // Stands in for the backdrop when the title has none.
  const poster = backdrop ? null : hero.posterUrl || hero.thumb || null;
  const logo = hero.clearlogoUrl;
  const rating = Math.max(hero.imdbRating || 0, hero.tmdbRating || 0);
  const runtime = formatRuntime(hero.duration);
  const summary = hero.summary || hero.tagline || '';

  return (
    <section className="relative -mx-4 sm:-mx-6 -mt-4 sm:-mt-6 mb-6 h-[44vh] min-h-[300px] max-h-[460px] overflow-hidden">
      {/* Backdrop */}
      {backdrop && (
        <>
          {!imgLoaded && <div className="absolute inset-0 bg-surface-900 animate-pulse" />}
          <img
            src={backdrop}
            alt=""
            loading="eager"
            onLoad={() => setImgLoaded(true)}
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${imgLoaded ? 'opacity-100' : 'opacity-0'} animate-ken-burns`}
          />
        </>
      )}

      {/* No backdrop: the poster, blurred, gives the banner its color */}
      {poster && (
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          loading="eager"
          className="absolute inset-0 w-full h-full object-cover scale-125 blur-3xl opacity-70"
        />
      )}

      {/* Gradient fades — bottom + left for legibility */}
      <div className="absolute inset-0 bg-gradient-to-t from-surface-950 via-surface-950/80 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-surface-950 via-surface-950/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-b from-surface-950/40 via-transparent to-transparent" />

      {/* No backdrop: the poster itself, sharp, on the right. Above the fades
          so it is not dimmed; left out on a phone, where the text needs the width. */}
      {poster && (
        <img
          src={poster}
          alt=""
          loading="eager"
          className="hidden sm:block absolute right-6 sm:right-10 top-1/2 -translate-y-1/2 h-[84%] aspect-[2/3] object-cover rounded-lg shadow-2xl shadow-black/60 ring-1 ring-white/10"
        />
      )}

      {/* Content */}
      <div className="relative h-full flex items-end pb-6 sm:pb-10 px-6 sm:px-10">
        <div className="max-w-xl">
          {hero.year && (
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber-300/90 font-bold mb-2">
              {hero.type === 'show' ? 'Featured Series' : 'Featured Tonight'}
            </div>
          )}
          {logo ? (
            <img src={logo} alt={hero.title} className="max-h-16 sm:max-h-20 mb-3 drop-shadow-[0_8px_24px_rgba(0,0,0,0.7)]" loading="eager" />
          ) : (
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-black tracking-tight text-white mb-3 drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)]">
              {hero.title}
            </h1>
          )}

          <div className="flex items-center gap-3 text-xs sm:text-sm text-gray-300 mb-4 font-medium">
            {rating > 0 && (
              <span className="flex items-center gap-1 text-amber-300">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.963a1 1 0 00.95.69h4.17c.969 0 1.371 1.24.588 1.81l-3.376 2.453a1 1 0 00-.363 1.118l1.287 3.963c.3.921-.755 1.688-1.54 1.118l-3.376-2.453a1 1 0 00-1.176 0l-3.376 2.453c-.784.57-1.838-.197-1.539-1.118l1.287-3.963a1 1 0 00-.363-1.118L2.05 9.39c-.783-.57-.38-1.81.588-1.81h4.17a1 1 0 00.95-.69l1.286-3.963z" /></svg>
                {rating.toFixed(1)}
              </span>
            )}
            {hero.year && <span>{hero.year}</span>}
            {runtime && <span>· {runtime}</span>}
            {hero.contentRating && (
              <span className="px-1.5 py-0.5 rounded border border-white/20 text-gray-300 text-[10px] font-semibold tracking-wider">
                {hero.contentRating}
              </span>
            )}
            {hero.resolution && (
              <span className="px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-300 text-[10px] font-bold tracking-wider">
                {hero.resolution}
              </span>
            )}
          </div>

          {summary && (
            <p className="text-xs sm:text-sm text-gray-200/90 line-clamp-2 sm:line-clamp-3 mb-3 max-w-lg leading-relaxed drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]">
              {summary}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onPlay && onPlay(hero)}
              className="inline-flex items-center gap-2 px-4 sm:px-5 py-2 rounded-full bg-gradient-to-r from-amber-300 via-amber-400 to-amber-500 text-black font-bold text-xs sm:text-sm shadow-lg shadow-amber-500/30 hover:shadow-amber-500/50 hover:scale-[1.02] transition-all"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              Play
            </button>
            <button
              type="button"
              onClick={() => onMoreInfo && onMoreInfo(hero)}
              className="inline-flex items-center gap-2 px-4 sm:px-5 py-2 rounded-full glass text-gray-100 font-semibold text-xs sm:text-sm hover:bg-white/[0.08] transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
              More info
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
