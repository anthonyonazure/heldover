import React, { useState, useEffect } from 'react';
import { getMoods, getTonightPicks } from '../lib/api';

const FALLBACK_MOODS = [
  { id: 'funny', label: 'Funny', emoji: '😂', description: 'Lighten the night' },
  { id: 'dark', label: 'Dark', emoji: '🌙', description: 'Heavy and slow burning' },
  { id: 'short', label: 'Short', emoji: '⏱️', description: 'Under 100 minutes' },
  { id: 'familiar', label: 'Familiar', emoji: '🛋️', description: 'Things you’ve loved' },
  { id: 'new', label: 'New', emoji: '✨', description: 'Added recently' },
  { id: 'epic', label: 'Epic', emoji: '🎬', description: 'Big runtime, big ratings' },
  { id: 'cozy', label: 'Cozy', emoji: '🫖', description: 'Warm and easy' },
  { id: 'mindbend', label: 'Mind-Bend', emoji: '🌀', description: 'Twists and ideas' },
];

function formatRuntime(ms) {
  if (!ms) return '';
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function PickCard({ item, onPick }) {
  const [trailerOn, setTrailerOn] = useState(false);
  const [hoverTimer, setHoverTimer] = useState(null);

  const onEnter = () => {
    const t = setTimeout(() => setTrailerOn(true), 700);
    setHoverTimer(t);
  };
  const onLeave = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    setTrailerOn(false);
  };

  return (
    <button
      type="button"
      onClick={() => onPick(item)}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="group text-left rounded-2xl overflow-hidden bg-surface-800 border border-surface-700 hover:border-amber-400 hover:shadow-xl hover:shadow-black/40 transition-all"
    >
      <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
        {item.posterUrl || item.thumb || item.backdropUrl ? (
          <img src={item.posterUrl || item.thumb || item.backdropUrl} alt={item.title} className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300" loading="lazy" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-surface-700 via-surface-800 to-surface-850 flex flex-col items-center justify-center p-3 text-center">
            <span className="text-3xl mb-2 opacity-40">🎬</span>
            <span className="text-xs font-semibold text-gray-200 line-clamp-3 leading-tight">{item.title}</span>
            {item.year && <span className="text-[10px] text-gray-500 mt-1">{item.year}</span>}
          </div>
        )}
        {trailerOn && item.tmdbId && (
          <iframe
            title={`trailer-${item.title}`}
            src={`https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(item.title + ' ' + (item.year || '') + ' trailer')}&autoplay=1&mute=1&controls=0`}
            className="absolute inset-0 w-full h-full"
            allow="autoplay; encrypted-media"
            frameBorder="0"
          />
        )}
      </div>
      <div className="p-3">
        <h4 className="text-sm font-semibold text-gray-100 truncate" title={item.title}>{item.title}</h4>
        <div className="flex items-center gap-2 text-[11px] text-gray-400 mt-1">
          {item.year && <span>{item.year}</span>}
          {item.duration && <span>· {formatRuntime(item.duration)}</span>}
          {item.imdbRating != null && <span className="text-amber-400">★ {item.imdbRating.toFixed(1)}</span>}
        </div>
      </div>
    </button>
  );
}

export default function TonightMode({ serverKey, libraryKey, onClose, onPickItem }) {
  const [moods, setMoods] = useState(FALLBACK_MOODS);
  const [mood, setMood] = useState('funny');
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getMoods().then((d) => setMoods(d.moods || FALLBACK_MOODS)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!serverKey || !libraryKey) return;
    setLoading(true);
    setError(null);
    getTonightPicks(serverKey, libraryKey, mood, 5)
      .then((d) => setPicks(d.items || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [serverKey, libraryKey, mood]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-y-auto" onClick={onClose}>
      <div className="relative w-full max-w-5xl glass rounded-2xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div>
            <h2 className="text-2xl font-extrabold text-gradient-amber tracking-tight">Tonight</h2>
            <p className="text-xs text-gray-400 mt-0.5">Five picks. Pick one. Press play.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-surface-700" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-5">
          <div className="flex gap-2 overflow-x-auto pb-3 -mx-1 px-1">
            {moods.map((m) => (
              <button
                key={m.id}
                onClick={() => setMood(m.id)}
                className={`flex-shrink-0 px-4 py-2 rounded-full border text-sm font-medium transition-all ${
                  mood === m.id
                    ? 'bg-amber-400 text-black border-amber-300 shadow-lg shadow-amber-500/20'
                    : 'bg-surface-800 text-gray-200 border-surface-700 hover:border-surface-600'
                }`}
              >
                <span className="mr-1.5">{m.emoji}</span>{m.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="aspect-[2/3] bg-surface-800 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <div className="text-center text-amber-300 p-6">{error}</div>
          ) : picks.length === 0 ? (
            <div className="text-center text-gray-400 p-6">No picks for this mood. Try another.</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">
              {picks.map((it) => (
                <PickCard key={it.ratingKey || it.plex_key || it.title} item={it} onPick={onPickItem} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
