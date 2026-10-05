import { useState, useEffect } from 'react';
import { getSimilar } from '../lib/api';
import RatingBadge from './RatingBadge';

export default function SimilarPanel({ item, onClose }) {
  const [similar, setSimilar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!item?.tmdbId) {
      setError('No TMDB data available for this title');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getSimilar(item.tmdbId, item.type || 'movie')
      .then((data) => {
        setSimilar(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [item]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-3xl max-h-[85vh] bg-surface-800 rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-white truncate">
              Similar to "{item.title}"
            </h2>
            <p className="text-sm text-gray-400 mt-0.5">
              {loading
                ? 'Finding recommendations...'
                : similar
                  ? `${similar.inLibrary?.length || 0} in your library, ${similar.notInLibrary?.length || 0} to discover`
                  : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <div className="text-center py-12 text-gray-400">
              <p>{error}</p>
            </div>
          )}

          {similar && !loading && (
            <>
              {/* In Library Section */}
              {similar.inLibrary?.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <span className="w-2 h-2 bg-green-500 rounded-full" />
                    In Your Library ({similar.inLibrary.length})
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {similar.inLibrary.map((rec) => (
                      <SimilarCard key={rec.tmdbId} item={rec} inLibrary />
                    ))}
                  </div>
                </div>
              )}

              {/* Not In Library Section */}
              {similar.notInLibrary?.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <span className="w-2 h-2 bg-gray-500 rounded-full" />
                    Worth Watching ({similar.notInLibrary.length})
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {similar.notInLibrary.map((rec) => (
                      <SimilarCard key={rec.tmdbId} item={rec} />
                    ))}
                  </div>
                </div>
              )}

              {similar.inLibrary?.length === 0 && similar.notInLibrary?.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <p>No similar titles found</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SimilarCard({ item, inLibrary = false }) {
  return (
    <div className={`rounded-lg overflow-hidden bg-surface-700 border transition-colors ${
      inLibrary ? 'border-green-500/30' : 'border-white/5'
    }`}>
      {/* Poster */}
      <div className="aspect-[2/3] relative bg-surface-900">
        {item.posterUrl ? (
          <img
            src={item.posterUrl}
            alt={item.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
        )}

        {/* Rating overlay */}
        {item.rating > 0 && (
          <div className="absolute bottom-1 left-1">
            <RatingBadge type="tmdb" value={item.rating} size="sm" />
          </div>
        )}

        {/* In Library badge */}
        {inLibrary && (
          <div className="absolute top-1 right-1 bg-green-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
            IN LIBRARY
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-2">
        <p className="text-sm font-medium text-white truncate">{item.title}</p>
        <p className="text-xs text-gray-400">{item.year || 'Unknown year'}</p>
      </div>
    </div>
  );
}
