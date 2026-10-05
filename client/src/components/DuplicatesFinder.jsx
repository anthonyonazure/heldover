import React, { useState, useEffect } from 'react';
import { getDuplicates } from '../lib/api';

function QualityTag({ quality }) {
  if (!quality) return null;
  const res = quality.resolution || quality.videoResolution;
  const codec = quality.videoCodec;
  const bitrate = quality.bitrate;

  return (
    <div className="flex gap-1 flex-wrap">
      {res && (
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
          String(res).includes('4k') || String(res).includes('2160')
            ? 'bg-purple-600 text-white'
            : String(res).includes('1080')
              ? 'bg-blue-600 text-white'
              : 'bg-gray-600 text-gray-200'
        }`}>
          {String(res).includes('4k') || String(res).includes('2160') ? '4K' : res}
        </span>
      )}
      {codec && (
        <span className="px-1.5 py-0.5 rounded text-[9px] bg-surface-600 text-gray-300">
          {codec}
        </span>
      )}
      {bitrate && (
        <span className="px-1.5 py-0.5 rounded text-[9px] bg-surface-600 text-gray-400">
          {Math.round(bitrate / 1000)}Mbps
        </span>
      )}
    </div>
  );
}

export default function DuplicatesFinder({ onClose }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    getDuplicates()
      .then((data) => {
        setGroups(Array.isArray(data) ? data : data.groups || data.duplicates || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      <div
        className="relative w-full sm:max-w-2xl max-h-[90vh] overflow-hidden bg-surface-800 rounded-t-2xl sm:rounded-2xl border border-surface-700 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-700 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-gray-100 flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Duplicates
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {loading ? 'Scanning...' : `${groups.length} duplicate group${groups.length !== 1 ? 's' : ''} found`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-white transition-smooth"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <div className="text-center py-12">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {!loading && !error && groups.length === 0 && (
            <div className="text-center py-12">
              <svg className="w-12 h-12 text-green-500 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-gray-300 font-medium">No duplicates found</p>
              <p className="text-sm text-gray-500 mt-1">Your library is clean!</p>
            </div>
          )}

          {!loading && groups.map((group, gi) => (
            <div key={gi} className="bg-surface-700/50 rounded-lg border border-surface-600 overflow-hidden">
              <div className="px-4 py-2.5 bg-surface-700 border-b border-surface-600">
                <h3 className="text-sm font-semibold text-gray-200">
                  {group.title || 'Unknown Title'}
                  {group.year && <span className="text-gray-500 font-normal ml-1.5">({group.year})</span>}
                </h3>
              </div>
              <div className="divide-y divide-surface-600">
                {(group.copies || group.items || []).map((copy, ci) => (
                  <div
                    key={ci}
                    className={`px-4 py-2.5 flex items-center justify-between gap-3 ${
                      copy.bestQuality ? 'bg-green-500/5' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 truncate">
                          {copy.serverName || 'Server'}
                          {copy.libraryTitle && ` / ${copy.libraryTitle}`}
                        </span>
                        {copy.bestQuality && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-600 text-white">
                            BEST
                          </span>
                        )}
                      </div>
                      <div className="mt-1">
                        <QualityTag quality={copy.quality || copy} />
                      </div>
                    </div>
                    {copy.fileSize && (
                      <span className="text-xs text-gray-500 shrink-0">
                        {(copy.fileSize / (1024 * 1024 * 1024)).toFixed(1)} GB
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
