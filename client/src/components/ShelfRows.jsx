import React, { useEffect, useRef, useState } from 'react';
import { getShelves } from '../lib/api';
import RatingBadge from './RatingBadge';
import ScrollRow from './ScrollRow';

// How many posters a shelf asks the server for, and how many of them are put on
// screen before the rest are revealed by scrolling. Asking for a deep shelf and
// rendering a shallow slice of it is what keeps a swipe from running out of
// track without paying for sixty posters worth of images up front.
const SHELF_DEPTH = 60;
const FIRST_BATCH = 20;
const REVEAL_STEP = 20;

/**
 * One-tap rows for the front page: Cozy, Short, Familiar, Funny.
 *
 * The rest of the app is built for someone who wants to filter. This is for
 * someone who does not — you arrive, four shelves are already picked, you
 * choose a poster. No library to select, no sliders to set.
 */
function ShelfCard({ item, onClick }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const poster = item.posterUrl || item.thumb;

  return (
    <button
      onClick={() => onClick && onClick(item)}
      className="flex-shrink-0 w-[105px] sm:w-[150px] text-left rounded-xl overflow-hidden bg-surface-850 border border-white/5 hover:border-amber-400/40 hover:scale-[1.06] hover:z-10 transition-all duration-300 ease-out hover:shadow-2xl hover:shadow-black/50"
    >
      <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
        {!failed && poster ? (
          <>
            {!loaded && <div className="absolute inset-0 animate-pulse bg-surface-700" />}
            <img
              src={poster}
              alt={item.title}
              loading="lazy"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            />
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center">
            <span className="text-2xl mb-1 opacity-40">🎬</span>
            <span className="text-[11px] font-semibold text-gray-200 line-clamp-3">{item.title}</span>
          </div>
        )}

        {item.imdbRating != null && (
          <div className="absolute bottom-1.5 left-1.5">
            <RatingBadge value={item.imdbRating} type="imdb" size="sm" />
          </div>
        )}
      </div>

      <div className="p-2">
        <h4 className="text-xs font-semibold text-gray-100 truncate" title={item.title}>{item.title}</h4>
        <span className="text-[10px] text-gray-500">{item.year || ''}</span>
      </div>
    </button>
  );
}

function Shelf({ shelf, onPick }) {
  const [shown, setShown] = useState(FIRST_BATCH);

  // A new shelf starts shallow again, or every row would stay as deep as the
  // deepest one you happened to scroll.
  useEffect(() => {
    setShown(FIRST_BATCH);
  }, [shelf.id]);

  const revealMore = () => {
    setShown((prev) => Math.min(prev + REVEAL_STEP, shelf.items.length));
  };

  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2 mb-2 px-1">
        <h3 className="text-sm font-bold text-gray-200">
          {shelf.emoji} {shelf.label}
        </h3>
        <span className="text-[11px] text-gray-500">{shelf.description}</span>
      </div>

      <ScrollRow className="gap-2.5 sm:gap-3 pb-2" ariaLabel={shelf.label} onReachEnd={revealMore}>
        {shelf.items.slice(0, shown).map((item) => (
          <ShelfCard key={`${item.serverKey}:${item.ratingKey}`} item={item} onClick={onPick} />
        ))}
      </ScrollRow>
    </section>
  );
}

export default function ShelfRows({ onPick }) {
  const [shelves, setShelves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notReady, setNotReady] = useState(false);
  const hasShelvesRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      getShelves({ count: SHELF_DEPTH })
        .then((d) => {
          if (cancelled) return;
          const next = d.shelves || [];
          hasShelvesRef.current = next.length > 0;
          setShelves(next);
          // A cold start has not read the libraries yet. Say so and try again
          // rather than showing an empty page that looks broken.
          setNotReady((d.librariesSearched || 0) === 0);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    };

    load();
    // The retry exists for one case: the server is still reading libraries and
    // has nothing to put on a shelf yet. It has to read whether shelves have
    // arrived from a ref, because an interval created once on mount is closed
    // over the first render's empty array forever — so the old `shelves.length`
    // check was always true, and the page quietly refetched every shelf every
    // thirty seconds for as long as it stayed open.
    const retry = setInterval(() => {
      if (cancelled) return;
      if (hasShelvesRef.current) {
        clearInterval(retry);
        return;
      }
      load();
    }, 30000);

    return () => {
      cancelled = true;
      clearInterval(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <div className="px-1 py-4 text-sm text-gray-500">Picking things out…</div>;
  }

  if (shelves.length === 0) {
    return (
      <div className="px-1 py-4 text-sm text-gray-500">
        {notReady
          ? 'Still reading your libraries. These shelves fill in on their own — check back in a minute.'
          : 'No shelves yet.'}
      </div>
    );
  }

  return (
    <div className="mt-2">
      {shelves.map((shelf) => (
        <Shelf key={shelf.id} shelf={shelf} onPick={onPick} />
      ))}
    </div>
  );
}
