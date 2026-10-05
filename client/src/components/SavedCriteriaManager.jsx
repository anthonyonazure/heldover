import React, { useState, useEffect, useCallback } from 'react';
import { getCriteria, deleteCriteria } from '../lib/api';

function summarizeCriteria(criteria) {
  const parts = [];
  if (criteria.genres?.length > 0) parts.push(criteria.genres.join(', '));
  if (criteria.minImdb > 0) parts.push(`${criteria.minImdb}+ IMDb`);
  if (criteria.minRt > 0) parts.push(`${criteria.minRt}%+ RT`);
  if (criteria.yearFrom) parts.push(`${criteria.yearFrom}+`);
  if (criteria.yearTo) parts.push(`to ${criteria.yearTo}`);
  if (criteria.mediaType && criteria.mediaType !== 'all') parts.push(criteria.mediaType === 'movie' ? 'Movies' : 'TV Shows');
  if (criteria.excludeGenres?.length > 0) parts.push(`-${criteria.excludeGenres.join(', -')}`);
  if (criteria.actor) parts.push(`Actor: ${criteria.actor}`);
  if (criteria.director) parts.push(`Dir: ${criteria.director}`);
  if (criteria.excludeWatched) parts.push('Unwatched');
  if (criteria.minRuntime) parts.push(`${criteria.minRuntime}+ min`);
  if (criteria.maxRuntime) parts.push(`<${criteria.maxRuntime} min`);
  if (criteria.contentRatings?.length > 0 && criteria.contentRatings.length < 10) {
    parts.push(criteria.contentRatings.join('/'));
  }
  return parts.length > 0 ? parts.join(' | ') : 'No filters';
}

export default function SavedCriteriaManager({ onApply }) {
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const fetchPresets = useCallback(async () => {
    try {
      const data = await getCriteria();
      setPresets(Array.isArray(data) ? data : data.criteria || []);
    } catch {
      setPresets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPresets();
  }, [fetchPresets]);

  const handleDelete = async (id) => {
    try {
      await deleteCriteria(id);
      setPresets((prev) => prev.filter((p) => p.id !== id));
      setConfirmDelete(null);
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-12 bg-surface-700 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (presets.length === 0) {
    return (
      <p className="text-xs text-gray-500 italic">No saved presets yet. Save your current filters to create one.</p>
    );
  }

  return (
    <div className="space-y-2">
      {presets.map((preset) => (
        <div
          key={preset.id}
          className="flex items-start gap-2 p-2.5 bg-surface-700 rounded-lg border border-surface-600 group"
        >
          <div className="flex-1 min-w-0">
            <h4 className="text-xs font-semibold text-gray-200 truncate">{preset.name}</h4>
            <p className="text-[10px] text-gray-500 mt-0.5 truncate">{summarizeCriteria(preset.criteria || preset)}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onApply && onApply(preset.criteria || preset)}
              className="px-2 py-1 rounded text-[10px] font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-smooth"
            >
              Apply
            </button>
            {confirmDelete === preset.id ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleDelete(preset.id)}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-smooth"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-surface-600 text-gray-400 hover:bg-surface-500 transition-smooth"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(preset.id)}
                className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-red-400/10 transition-smooth opacity-0 group-hover:opacity-100"
                title="Delete"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
