import React, { useEffect, useState } from 'react';
import { getBecauseYouLikedRows, getHiddenGems, getRecentlyAddedDiscovery } from '../lib/api';
import ScrollRow from './ScrollRow';

// Same shape as the shelves: ask deep, draw shallow, reveal on scroll.
const ROW_DEPTH = 60;
const FIRST_BATCH = 20;
const REVEAL_STEP = 20;

function Row({ title, items, onItemClick, accent = 'text-amber-300' }) {
  const [shown, setShown] = useState(FIRST_BATCH);

  useEffect(() => {
    setShown(FIRST_BATCH);
  }, [title]);

  if (!items || items.length === 0) return null;

  const revealMore = () => setShown((prev) => Math.min(prev + REVEAL_STEP, items.length));

  return (
    <div className="mb-8">
      <h3 className={`text-[11px] font-bold uppercase tracking-[0.18em] mb-3 px-1 ${accent}`}>{title}</h3>
      <ScrollRow className="gap-2.5 sm:gap-4 pb-3" ariaLabel={title} onReachEnd={revealMore}>
          {items.slice(0, shown).map((it) => (
            <button
              key={it.ratingKey || it.plex_key || it.title}
              onClick={() => onItemClick && onItemClick(it)}
              className="flex-shrink-0 w-[105px] sm:w-[180px] text-left rounded-xl overflow-hidden bg-surface-850 border border-white/5 hover:border-amber-400/40 hover:scale-[1.06] hover:z-10 transition-all duration-300 ease-out hover:shadow-2xl hover:shadow-black/50"
            >
              <div className="relative aspect-[2/3] bg-surface-800 overflow-hidden">
                {it.posterUrl || it.thumb || it.backdropUrl ? (
                  <img src={it.posterUrl || it.thumb || it.backdropUrl} alt={it.title} loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-surface-700 via-surface-800 to-surface-850 flex flex-col items-center justify-center p-3 text-center">
                    <span className="text-2xl mb-2 opacity-40">🎬</span>
                    <span className="text-[11px] font-semibold text-gray-300 line-clamp-3 leading-tight">{it.title}</span>
                    {it.year && <span className="text-[10px] text-gray-500 mt-1">{it.year}</span>}
                  </div>
                )}
                {typeof it.imdbRating === 'number' && it.imdbRating > 0 && (
                  <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/70 backdrop-blur-sm text-amber-300 text-[10px] font-bold">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.963a1 1 0 00.95.69h4.17c.969 0 1.371 1.24.588 1.81l-3.376 2.453a1 1 0 00-.363 1.118l1.287 3.963c.3.921-.755 1.688-1.54 1.118l-3.376-2.453a1 1 0 00-1.176 0l-3.376 2.453c-.784.57-1.838-.197-1.539-1.118l1.287-3.963a1 1 0 00-.363-1.118L2.05 9.39c-.783-.57-.38-1.81.588-1.81h4.17a1 1 0 00.95-.69l1.286-3.963z" /></svg>
                    {it.imdbRating.toFixed(1)}
                  </div>
                )}
              </div>
              <div className="p-2">
                <div className="text-xs font-semibold text-gray-100 truncate" title={it.title}>{it.title}</div>
                <div className="text-[10px] text-gray-500">{it.year || ''}</div>
              </div>
            </button>
          ))}
      </ScrollRow>
    </div>
  );
}

export default function DiscoveryRows({ serverKey, libraryKey, onItemClick }) {
  const [becauseRows, setBecauseRows] = useState([]);
  const [hiddenGems, setHiddenGems] = useState([]);
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    if (!serverKey || !libraryKey) return;

    // Same reason as the library fetch in App: switch libraries quickly and a
    // slow answer for the old one can arrive last and fill these rows with
    // titles from a library you are no longer looking at.
    let current = true;
    const set = (fn) => (value) => {
      if (current) fn(value);
    };

    getBecauseYouLikedRows(serverKey, libraryKey, 3)
      .then((d) => set(setBecauseRows)(d.rows || []))
      .catch(() => set(setBecauseRows)([]));
    getHiddenGems(serverKey, libraryKey, ROW_DEPTH)
      .then((d) => set(setHiddenGems)(d.items || []))
      .catch(() => set(setHiddenGems)([]));
    getRecentlyAddedDiscovery(serverKey, libraryKey, 30, ROW_DEPTH)
      .then((d) => set(setRecent)(d.items || []))
      .catch(() => set(setRecent)([]));

    return () => {
      current = false;
    };
  }, [serverKey, libraryKey]);

  const hasAny = becauseRows.length > 0 || hiddenGems.length > 0 || recent.length > 0;
  if (!hasAny) return null;

  return (
    <div className="mb-8">
      <Row title="Recently Added — Unseen by You" items={recent} onItemClick={onItemClick} accent="text-cyan-300" />
      <Row title="Hidden Gems" items={hiddenGems} onItemClick={onItemClick} accent="text-emerald-300" />
      {becauseRows.map((row) => (
        <Row
          key={row.seed?.ratingKey}
          title={`Because you liked ${row.seed?.title || 'something'}`}
          items={row.items}
          onItemClick={onItemClick}
          accent="text-amber-300"
        />
      ))}
    </div>
  );
}
