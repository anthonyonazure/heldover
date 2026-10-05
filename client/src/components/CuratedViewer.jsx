import React, { useEffect, useState } from 'react';
import { getCuratedViewItems } from '../lib/api';
import MediaCard from './MediaCard';

export default function CuratedViewer({ slug, onItemClick, onLeave }) {
  const [view, setView] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    getCuratedViewItems(slug)
      .then((d) => { setView(d.view); setItems(d.items || []); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-900 p-6 sm:p-10">
        <div className="max-w-7xl mx-auto">
          <div className="h-8 bg-surface-800 rounded animate-pulse w-1/3 mb-3" />
          <div className="h-4 bg-surface-800 rounded animate-pulse w-1/2 mb-8" />
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-[2/3] bg-surface-800 rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-surface-900 p-6 sm:p-10 flex items-center justify-center">
        <div className="text-center">
          <div className="text-amber-300 mb-3">{error}</div>
          <button onClick={onLeave} className="px-4 py-2 rounded-lg bg-surface-700 text-gray-200 hover:bg-surface-600">Back to library</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-900">
      <div className="border-b border-surface-700 bg-gradient-to-b from-surface-800 to-surface-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-8 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-amber-400 font-bold">Curated view</div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-50 mt-1">{view?.name}</h1>
            {view?.description && <p className="text-sm text-gray-400 mt-1.5">{view.description}</p>}
            <div className="text-[11px] text-gray-500 mt-2">{items.length} picks</div>
          </div>
          <button onClick={onLeave} className="text-xs px-3 py-1.5 rounded-lg bg-surface-800 text-gray-300 hover:bg-surface-700 border border-surface-700 flex-shrink-0">
            Exit view
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-6">
        {items.length === 0 ? (
          <div className="text-center text-gray-400 py-12">Nothing in this view right now.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {items.map((it) => (
              <MediaCard
                key={it.ratingKey || it.plex_key}
                item={it}
                onClick={() => onItemClick && onItemClick(it)}
                serverKey={view?.server_key}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
