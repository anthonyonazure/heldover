import React, { useState, useEffect } from 'react';
import { findTitles } from '../lib/api';

/**
 * What the search box finds when no library is open: every server's titles
 * matching the words typed, one card per film however many servers hold it.
 * Inside a library the same box filters that library instead (plot, cast and
 * so on), because only there are the full records on hand.
 */
export default function TitleSearchResults({ query, libraries, onPick }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResult(null);
      return undefined;
    }
    const controller = new AbortController();
    // Wait for a pause in typing, and drop an answer that a newer one overtook.
    const timer = setTimeout(async () => {
      try {
        setError('');
        setResult(await findTitles(q, controller.signal));
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  if (!query.trim()) return null;

  const serverName = (key) => {
    const lib = libraries.find((l) => l.serverKey === key);
    return lib ? lib.serverName : '';
  };

  return (
    <section className="mb-6" data-testid="title-search-results">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] text-gray-500">
          {result ? `${result.count} title${result.count === 1 ? '' : 's'} across every server` : 'Searching every server...'}
        </span>
      </div>
      {error && <p className="text-sm text-amber-300">{error}</p>}
      {result?.stillReading && <p className="text-sm text-gray-500">Still reading your libraries. Try again in a minute.</p>}
      {result && result.count === 0 && !result.stillReading && (
        <p className="text-sm text-gray-500 py-4">No server has a title with those words in its name.</p>
      )}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5 sm:gap-3">
        {(result?.items || []).map((item) => {
          const names = [...new Set(item.serverKeys.map(serverName).filter(Boolean))];
          return (
            <button
              key={`${item.serverKey}:${item.ratingKey}`}
              onClick={() => onPick && onPick(item)}
              className="group text-left rounded-xl overflow-hidden bg-surface-850 border border-white/5 hover:border-amber-400/40 hover:scale-[1.04] transition-all duration-300"
            >
              <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
                {item.thumb ? (
                  <img src={item.thumb} alt={item.title} loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-2xl opacity-40">🎬</div>
                )}
              </div>
              <div className="p-2">
                <h4 className="text-xs font-semibold text-gray-100 truncate">{item.title}</h4>
                <span className="text-[10px] text-gray-500">{item.year || ''}</span>
                {names.length > 0 && (
                  <div className="text-[10px] text-gray-500 truncate" title={names.join(', ')}>
                    {names.join(', ')}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
