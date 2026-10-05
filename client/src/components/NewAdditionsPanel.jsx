import React, { useState, useEffect, useCallback } from 'react';
import { getNewAdditions, getMatchingNewAdditions, getCriteria } from '../lib/api';
import ScrollRow from './ScrollRow';

function AdditionCard({ item, onPick }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const posterUrl = item.posterUrl || item.thumb;

  return (
    <button
      type="button"
      onClick={() => onPick && onPick(item)}
      className="flex-shrink-0 w-[105px] sm:w-[160px] group text-left"
    >
      <div className="relative rounded-lg overflow-hidden bg-surface-800 border border-surface-700 hover:border-surface-600 hover:scale-[1.03] transition-all duration-300 hover:shadow-xl hover:shadow-black/30">
        {/* Poster */}
        <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
          {!imgError && posterUrl ? (
            <>
              {!imgLoaded && <div className="absolute inset-0 animate-pulse bg-surface-700" />}
              <img
                src={posterUrl}
                alt={item.title}
                loading="lazy"
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgError(true)}
                className={`w-full h-full object-cover transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
              />
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600">
              <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
              </svg>
            </div>
          )}

          {/* NEW badge */}
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-500 text-white shadow-lg shadow-green-500/30">
            NEW
          </span>

          {/* Source badge */}
          {(item.serverName || item.libraryTitle) && (
            <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[8px] font-medium bg-black/70 text-gray-300 truncate max-w-[100px]">
              {item.serverName && item.libraryTitle
                ? `${item.serverName} / ${item.libraryTitle}`
                : item.serverName || item.libraryTitle}
            </span>
          )}
        </div>

        {/* Info */}
        <div className="p-2">
          <h4 className="text-xs font-semibold text-gray-100 truncate" title={item.title}>
            {item.title}
          </h4>
          <span className="text-[10px] text-gray-500">{item.year || ''}</span>
        </div>
      </div>
    </button>
  );
}

export default function NewAdditionsPanel({ onPick }) {
  const [additions, setAdditions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [savedCriteria, setSavedCriteria] = useState([]);
  const [selectedCriteria, setSelectedCriteria] = useState('');

  const fetchAdditions = useCallback(async (criteriaId) => {
    setLoading(true);
    try {
      let data;
      if (criteriaId) {
        data = await getMatchingNewAdditions(criteriaId, 7);
      } else {
        data = await getNewAdditions(7);
      }
      setAdditions(Array.isArray(data) ? data : data.additions || data.items || []);
    } catch {
      setAdditions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCriteria = useCallback(async () => {
    try {
      const data = await getCriteria();
      setSavedCriteria(Array.isArray(data) ? data : data.criteria || []);
    } catch {
      // criteria endpoint may not exist yet
    }
  }, []);

  useEffect(() => {
    fetchAdditions();
    fetchCriteria();
  }, [fetchAdditions, fetchCriteria]);

  const handleCriteriaChange = (value) => {
    setSelectedCriteria(value);
    fetchAdditions(value || null);
  };


  if (!loading && additions.length === 0) return null;

  return (
    <div className="mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setCollapsed((prev) => !prev)}
          className="flex items-center gap-2 group"
        >
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wide group-hover:text-accent transition-smooth">
            New This Week
            {!loading && additions.length > 0 && (
              <span className="ml-1.5 text-accent font-normal">({additions.length} items)</span>
            )}
          </h2>
        </button>

        <div className="flex items-center gap-2">
          {/* Criteria filter dropdown */}
          {savedCriteria.length > 0 && (
            <select
              value={selectedCriteria}
              onChange={(e) => handleCriteriaChange(e.target.value)}
              className="px-2 py-1 bg-surface-700 border border-surface-600 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-accent transition-smooth"
            >
              <option value="">All</option>
              {savedCriteria.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}

          {/* Refresh */}
          <button
            onClick={() => fetchAdditions(selectedCriteria || null)}
            className="p-1.5 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-accent transition-smooth"
            title="Refresh"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          collapsed ? 'max-h-0 opacity-0' : 'max-h-[400px] opacity-100'
        }`}
      >
        {loading ? (
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-[105px] sm:w-[160px] animate-pulse">
                <div className="aspect-[2/3] bg-surface-700 rounded-lg" />
                <div className="mt-2 h-3 bg-surface-700 rounded w-3/4" />
              </div>
            ))}
          </div>
        ) : (
          <ScrollRow className="gap-2.5 sm:gap-3 pb-2" ariaLabel="new this week">
            {additions.map((item, i) => (
              <AdditionCard key={item.ratingKey || item.key || i} item={item} onPick={onPick} />
            ))}
          </ScrollRow>
        )}
      </div>
    </div>
  );
}
