import React, { useState, useEffect, useMemo } from 'react';
import {
  getListSources,
  getProviderLists,
  getListItems,
} from '../lib/api';

const PROVIDER_META = {
  mdblist:    { label: 'MDBList',    color: 'text-orange-300', emoji: '📋' },
  tmdb:       { label: 'TMDB',       color: 'text-cyan-300',   emoji: '🎞️' },
  letterboxd: { label: 'Letterboxd', color: 'text-green-300',  emoji: '🟢' },
  trakt:      { label: 'Trakt',      color: 'text-red-300',    emoji: '🔴' },
};

function ListItemCard({ entry, onPickInLibrary, onPickExternal }) {
  const li = entry.libraryItem;
  const poster = li?.posterUrl || entry.poster;
  return (
    <button
      type="button"
      onClick={() => (entry.inLibrary ? onPickInLibrary(li) : onPickExternal(entry))}
      className={`group text-left rounded-lg overflow-hidden bg-surface-800 border transition-all ${
        entry.inLibrary
          ? 'border-amber-500/50 hover:border-amber-400 hover:scale-[1.02] cursor-pointer hover:shadow-lg'
          : 'border-surface-700 hover:border-surface-600 opacity-70 hover:opacity-100'
      }`}
    >
      <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
        {poster ? (
          <img src={poster} alt={entry.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">🎬</div>
        )}
        {entry.inLibrary ? (
          <div className="absolute top-1.5 right-1.5 bg-amber-400 text-black text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded">
            In Library
          </div>
        ) : (
          <div className="absolute top-1.5 right-1.5 bg-black/70 text-gray-300 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded">
            Not In Library
          </div>
        )}
      </div>
      <div className="p-2">
        <h4 className="text-xs font-semibold text-gray-100 truncate" title={entry.title}>{entry.title}</h4>
        <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1">
          {entry.year && <span>{entry.year}</span>}
          {entry.type === 'show' && <span>· TV</span>}
        </div>
      </div>
    </button>
  );
}

function ListRow({ list, active, onClick }) {
  return (
    <button
      onClick={() => onClick(list)}
      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${
        active
          ? 'bg-amber-400/10 text-amber-300 border border-amber-500/30'
          : 'text-gray-300 hover:bg-surface-800 border border-transparent'
      }`}
    >
      <div className="font-medium truncate">{list.name}</div>
      {(list.itemCount || list.owner) && (
        <div className="text-[11px] text-gray-500 mt-0.5">
          {list.itemCount ? `${list.itemCount} items` : ''}
          {list.itemCount && list.owner ? ' · ' : ''}
          {list.owner || ''}
        </div>
      )}
    </button>
  );
}

export default function ExternalLists({ serverKey, libraryKey, onClose, onPickInLibrary }) {
  const [sources, setSources] = useState({});
  const [provider, setProvider] = useState(null);
  const [listings, setListings] = useState(null);
  const [activeList, setActiveList] = useState(null);
  const [items, setItems] = useState([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    getListSources().then((d) => {
      setSources(d.sources || {});
      const firstAvailable = Object.entries(d.sources || {}).find(([, ok]) => ok)?.[0];
      if (firstAvailable) setProvider(firstAvailable);
    }).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!provider) return;
    setLoadingListings(true);
    setListings(null);
    setActiveList(null);
    setItems([]);
    getProviderLists(provider)
      .then(setListings)
      .catch((err) => setError(err.message))
      .finally(() => setLoadingListings(false));
  }, [provider]);

  useEffect(() => {
    if (!activeList || !provider) return;
    setLoadingItems(true);
    setItems([]);
    setError(null);
    getListItems(provider, activeList.id, { serverKey, libraryKey, matchAll: !libraryKey })
      .then((d) => setItems(d.items || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoadingItems(false));
  }, [activeList, provider, serverKey, libraryKey]);

  const flatLists = useMemo(() => {
    if (!listings) return [];
    if (listings.user || listings.top) {
      return [
        ...(listings.user || []).map((l) => ({ ...l, section: 'Your Lists' })),
        ...(listings.top || []).map((l) => ({ ...l, section: 'Top Lists' })),
      ];
    }
    return (listings.builtin || []).map((l) => ({ ...l, section: 'Built-in' }));
  }, [listings]);

  const filteredLists = useMemo(() => {
    if (!search) return flatLists;
    const q = search.toLowerCase();
    return flatLists.filter((l) => l.name.toLowerCase().includes(q));
  }, [flatLists, search]);

  const grouped = useMemo(() => {
    const out = {};
    for (const l of filteredLists) {
      const sec = l.section || 'Lists';
      if (!out[sec]) out[sec] = [];
      out[sec].push(l);
    }
    return out;
  }, [filteredLists]);

  const inLibCount = items.filter((it) => it.inLibrary).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex items-stretch justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="relative w-full max-w-7xl glass sm:rounded-2xl shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-white/5">
          <div>
            <h2 className="text-xl font-bold text-gray-50">Browse lists</h2>
            <p className="text-xs text-gray-400 mt-0.5">From the rest of the internet, matched against your libraries.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-surface-800" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar: providers + lists */}
          <aside className="w-64 sm:w-72 border-r border-white/5 flex-shrink-0 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-white/5 flex gap-1 overflow-x-auto">
              {Object.entries(PROVIDER_META).map(([p, meta]) => {
                const enabled = sources[p];
                return (
                  <button
                    key={p}
                    onClick={() => enabled && setProvider(p)}
                    disabled={!enabled}
                    title={enabled ? meta.label : `${meta.label} not configured`}
                    className={`flex-shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                      provider === p
                        ? 'bg-amber-400/15 text-amber-300 border border-amber-500/30'
                        : enabled
                          ? 'bg-surface-800 text-gray-300 hover:bg-surface-700 border border-surface-700'
                          : 'bg-surface-800/30 text-gray-600 border border-surface-800 cursor-not-allowed'
                    }`}
                  >
                    {meta.emoji} {meta.label}
                  </button>
                );
              })}
            </div>

            <div className="p-3 border-b border-white/5">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter lists…"
                className="w-full px-3 py-1.5 bg-white/[0.04] text-gray-200 text-sm rounded-md border border-white/10 focus:border-amber-400/60 focus:outline-none"
              />
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-3">
              {loadingListings && <div className="text-xs text-gray-500 p-2">Loading…</div>}
              {!loadingListings && Object.entries(grouped).map(([section, lists]) => (
                <div key={section}>
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold px-2 mb-1">{section}</div>
                  <div className="space-y-1">
                    {lists.map((l) => (
                      <ListRow key={l.source + ':' + l.id} list={l} active={activeList?.id === l.id} onClick={setActiveList} />
                    ))}
                  </div>
                </div>
              ))}
              {!loadingListings && filteredLists.length === 0 && (
                <div className="text-xs text-gray-500 p-2">No lists.</div>
              )}
            </div>
          </aside>

          {/* Main: items grid */}
          <main className="flex-1 overflow-y-auto p-4 sm:p-5">
            {!activeList && (
              <div className="text-gray-500 text-sm text-center mt-20">
                Pick a list on the left.
              </div>
            )}

            {activeList && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-bold text-gray-50">{activeList.name}</h3>
                    {activeList.description && (
                      <p className="text-xs text-gray-400 mt-0.5">{activeList.description}</p>
                    )}
                  </div>
                  {!loadingItems && items.length > 0 && (
                    <div className="text-xs text-gray-400 flex-shrink-0 ml-3">
                      <span className="text-amber-400 font-semibold">{inLibCount}</span>
                      {` / ${items.length} in library`}
                    </div>
                  )}
                </div>

                {error && <div className="text-amber-300 text-sm mb-4">{error}</div>}

                {loadingItems ? (
                  <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
                    {Array.from({ length: 18 }).map((_, i) => (
                      <div key={i} className="aspect-[2/3] bg-surface-800 rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
                    {items.map((it, i) => (
                      <ListItemCard
                        key={`${it.imdbId || it.tmdbId || it.title}-${i}`}
                        entry={it}
                        onPickInLibrary={onPickInLibrary}
                        onPickExternal={(e) => {
                          const q = encodeURIComponent(`${e.title} ${e.year || ''}`.trim());
                          window.open(`https://www.themoviedb.org/search?query=${q}`, '_blank');
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
