import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getActors, getDirectors, saveCriteria, getCriteria } from '../lib/api';
import SavedCriteriaManager from './SavedCriteriaManager';

const SORT_OPTIONS = [
  { value: 'imdb', label: 'IMDb Rating' },
  { value: 'rt', label: 'Rotten Tomatoes' },
  { value: 'tmdb', label: 'TMDB Rating' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
];

const CONTENT_RATINGS = [
  'G', 'PG', 'PG-13', 'R', 'NC-17',
  'TV-Y', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA',
];

function CollapsibleSection({ title, defaultOpen = false, children, badge }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-surface-700/50 pb-3 last:border-b-0">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center justify-between w-full py-1.5 group"
      >
        <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider group-hover:text-accent transition-smooth flex items-center gap-2">
          {title}
          {badge && (
            <span className="text-[9px] font-medium bg-accent/20 text-accent px-1.5 py-0.5 rounded-full normal-case">
              {badge}
            </span>
          )}
        </span>
        <svg
          className={`w-3.5 h-3.5 text-gray-600 transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          open ? 'max-h-[800px] opacity-100 mt-2' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="space-y-4">{children}</div>
      </div>
    </div>
  );
}

function PersonAutocomplete({ label, placeholder, value, onChange, fetchSuggestions }) {
  const [query, setQuery] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    const handleClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleInput = (e) => {
    const val = e.target.value;
    setQuery(val);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (val.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      if (!val) onChange('');
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const results = await fetchSuggestions(val);
        const list = Array.isArray(results) ? results : results.items || [];
        setSuggestions(list.slice(0, 10));
        setShowSuggestions(true);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  };

  const selectSuggestion = (name) => {
    setQuery(name);
    onChange(name);
    setShowSuggestions(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      onChange(query);
      setShowSuggestions(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
        {label}
      </label>
      <input
        type="text"
        placeholder={placeholder}
        value={query}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
        className="w-full px-3 py-2 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-smooth"
      />
      {loading && (
        <div className="absolute right-3 top-[34px]">
          <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {showSuggestions && suggestions.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-surface-800 border border-surface-600 rounded-lg shadow-2xl overflow-hidden max-h-48 overflow-y-auto">
          {suggestions.map((s, i) => {
            const name = typeof s === 'string' ? s : s.name || s.tag;
            return (
              <button
                key={name || i}
                onClick={() => selectSuggestion(name)}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-accent/20 hover:text-accent transition-smooth"
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function FilterPanel({
  libraries,
  selectedLibrary,
  onSelectLibrary,
  filters,
  onFilterChange,
  genres,
  onClearAll,
  isMobile,
  onClose,
}) {
  const [saveName, setSaveName] = useState('');
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  const handleChange = (key, value) => {
    onFilterChange({ ...filters, [key]: value });
  };

  const toggleGenre = (genre) => {
    const current = filters.genres || [];
    const next = current.includes(genre) ? current.filter((g) => g !== genre) : [...current, genre];
    handleChange('genres', next);
  };

  const toggleExcludeGenre = (genre) => {
    const current = filters.excludeGenres || [];
    const next = current.includes(genre) ? current.filter((g) => g !== genre) : [...current, genre];
    handleChange('excludeGenres', next);
  };

  const toggleContentRating = (rating) => {
    const current = filters.contentRatings || [...CONTENT_RATINGS];
    const next = current.includes(rating) ? current.filter((r) => r !== rating) : [...current, rating];
    handleChange('contentRatings', next);
  };

  const hasActiveFilters =
    filters.search ||
    filters.mediaType !== 'all' ||
    filters.minImdb > 0 ||
    filters.minRt > 0 ||
    (filters.genres && filters.genres.length > 0) ||
    (filters.excludeGenres && filters.excludeGenres.length > 0) ||
    (filters.contentRatings && filters.contentRatings.length > 0 && filters.contentRatings.length < CONTENT_RATINGS.length) ||
    filters.actor ||
    filters.director ||
    filters.minRuntime ||
    filters.maxRuntime ||
    filters.releasedAfter ||
    filters.releasedBefore ||
    filters.excludeWatched ||
    filters.hideDisliked ||
    filters.likedOnly ||
    filters.yearFrom ||
    filters.yearTo;

  // Group libraries by server
  const grouped = {};
  (libraries || []).forEach((lib) => {
    const serverName = lib.serverName || 'Server';
    if (!grouped[serverName]) grouped[serverName] = [];
    grouped[serverName].push(lib);
  });

  // Get current server/library keys for person search
  const [serverKey, libraryKey] = (selectedLibrary || '').split(':');

  const fetchActorSuggestions = useCallback(
    async (query) => {
      if (!serverKey || !libraryKey) return [];
      try {
        return await getActors(serverKey, libraryKey);
      } catch {
        return [];
      }
    },
    [serverKey, libraryKey]
  );

  const fetchDirectorSuggestions = useCallback(
    async (query) => {
      if (!serverKey || !libraryKey) return [];
      try {
        return await getDirectors(serverKey, libraryKey);
      } catch {
        return [];
      }
    },
    [serverKey, libraryKey]
  );

  const handleSaveCriteria = async () => {
    if (!saveName.trim()) return;
    setSaveStatus('saving');
    try {
      await saveCriteria(saveName.trim(), {
        ...filters,
      });
      setSaveStatus('saved');
      setSaveName('');
      setShowSavePrompt(false);
      setTimeout(() => setSaveStatus(''), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(''), 3000);
    }
  };

  const handleApplyPreset = (criteria) => {
    onFilterChange({ ...filters, ...criteria });
  };

  // Count active filters for each section badge
  const ratingCount = (filters.minImdb > 0 ? 1 : 0) + (filters.minRt > 0 ? 1 : 0);
  const genreCount =
    (filters.genres?.length || 0) +
    (filters.excludeGenres?.length || 0) +
    (filters.contentRatings && filters.contentRatings.length < CONTENT_RATINGS.length ? 1 : 0);
  const peopleCount = (filters.actor ? 1 : 0) + (filters.director ? 1 : 0);
  const detailsCount =
    (filters.yearFrom ? 1 : 0) +
    (filters.yearTo ? 1 : 0) +
    (filters.minRuntime ? 1 : 0) +
    (filters.maxRuntime ? 1 : 0) +
    (filters.releasedAfter ? 1 : 0) +
    (filters.releasedBefore ? 1 : 0) +
    (filters.excludeWatched ? 1 : 0) +
    (filters.hideDisliked ? 1 : 0) +
    (filters.likedOnly ? 1 : 0);

  return (
    <div
      className={`
      ${isMobile ? 'w-full h-full' : 'w-[280px] min-w-[280px] h-[calc(100vh-57px)]'}
      bg-surface-800 border-r border-surface-700 overflow-y-auto flex flex-col
    `}
    >
      {/* Mobile close header */}
      {isMobile && (
        <div className="flex items-center justify-between p-4 border-b border-surface-700">
          <h2 className="text-lg font-bold text-accent">Filters</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-700">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="p-4 space-y-3 flex-1">
        {/* === SECTION 1: Search & Library === */}
        <CollapsibleSection title="Search & Library" defaultOpen={true}>
          {/* Search */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              Search
            </label>
            <input
              type="text"
              placeholder='Try: "time travel", 4k, unwatched, under 90...'
              value={filters.search || ''}
              onChange={(e) => handleChange('search', e.target.value)}
              className="w-full px-3 py-2 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-smooth"
            />
          </div>

          {/* Library picker */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              Library
            </label>
            <select
              value={selectedLibrary || ''}
              onChange={(e) => onSelectLibrary(e.target.value)}
              className="w-full px-3 py-2 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 focus:outline-none focus:border-accent transition-smooth"
            >
              <option value="">Select a library...</option>
              {Object.entries(grouped).map(([serverName, libs]) => (
                <optgroup key={serverName} label={serverName}>
                  {libs.map((lib) => (
                    <option key={`${lib.serverKey}:${lib.key}`} value={`${lib.serverKey}:${lib.key}`}>
                      {lib.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Media type */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              Media Type
            </label>
            <div className="flex gap-1">
              {['all', 'movie', 'show'].map((type) => (
                <button
                  key={type}
                  onClick={() => handleChange('mediaType', type)}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-smooth ${
                    filters.mediaType === type
                      ? 'bg-accent text-black'
                      : 'bg-surface-700 text-gray-400 hover:text-gray-200 hover:bg-surface-600'
                  }`}
                >
                  {type === 'all' ? 'All' : type === 'movie' ? 'Movies' : 'TV Shows'}
                </button>
              ))}
            </div>
          </div>

          {/* Sort */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              Sort By
            </label>
            <div className="flex gap-2">
              <select
                value={filters.sortBy || 'imdb'}
                onChange={(e) => handleChange('sortBy', e.target.value)}
                className="flex-1 px-3 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 focus:outline-none focus:border-accent transition-smooth"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleChange('sortOrder', filters.sortOrder === 'asc' ? 'desc' : 'asc')}
                className="px-3 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm hover:bg-surface-600 transition-smooth"
                title={filters.sortOrder === 'asc' ? 'Ascending' : 'Descending'}
              >
                {filters.sortOrder === 'asc' ? '\u2191' : '\u2193'}
              </button>
            </div>
          </div>
        </CollapsibleSection>

        {/* === SECTION 2: Ratings === */}
        <CollapsibleSection title="Ratings" defaultOpen={true} badge={ratingCount > 0 ? ratingCount : null}>
          {/* IMDB Rating Slider */}
          <div>
            <label className="flex items-center justify-between text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              <span>Min IMDb Rating</span>
              <span className="text-imdb font-bold normal-case">
                {filters.minImdb > 0 ? filters.minImdb.toFixed(1) : 'Any'}
              </span>
            </label>
            <input
              type="range"
              min="0"
              max="10"
              step="0.5"
              value={filters.minImdb || 0}
              onChange={(e) => handleChange('minImdb', parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>0</span>
              <span>5</span>
              <span>10</span>
            </div>
          </div>

          {/* Rotten Tomatoes Slider */}
          <div>
            <label className="flex items-center justify-between text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              <span>Min Rotten Tomatoes</span>
              <span className="text-rt-fresh font-bold normal-case">
                {filters.minRt > 0 ? `${filters.minRt}%` : 'Any'}
              </span>
            </label>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={filters.minRt || 0}
              onChange={(e) => handleChange('minRt', parseInt(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>
        </CollapsibleSection>

        {/* === SECTION 3: Genre & Content === */}
        <CollapsibleSection title="Genre & Content" badge={genreCount > 0 ? genreCount : null}>
          {/* Include Genres */}
          {genres && genres.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
                Include Genres {filters.genres?.length > 0 && `(${filters.genres.length})`}
              </label>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pr-1">
                {genres.map((genre) => {
                  const active = (filters.genres || []).includes(genre);
                  return (
                    <button
                      key={genre}
                      onClick={() => toggleGenre(genre)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-smooth ${
                        active
                          ? 'bg-accent text-black'
                          : 'bg-surface-700 text-gray-400 hover:text-gray-200 hover:bg-surface-600'
                      }`}
                    >
                      {genre}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Exclude Genres */}
          {genres && genres.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
                Exclude Genres {filters.excludeGenres?.length > 0 && `(${filters.excludeGenres.length})`}
              </label>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pr-1">
                {genres.map((genre) => {
                  const active = (filters.excludeGenres || []).includes(genre);
                  return (
                    <button
                      key={genre}
                      onClick={() => toggleExcludeGenre(genre)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-smooth ${
                        active
                          ? 'bg-red-500/30 text-red-400 line-through border border-red-500/40'
                          : 'bg-surface-700 text-gray-400 hover:text-gray-200 hover:bg-surface-600'
                      }`}
                    >
                      {genre}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Content Rating */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              Content Rating
            </label>
            <div className="flex flex-wrap gap-1.5">
              {CONTENT_RATINGS.map((rating) => {
                const current = filters.contentRatings || [...CONTENT_RATINGS];
                const active = current.includes(rating);
                return (
                  <button
                    key={rating}
                    onClick={() => toggleContentRating(rating)}
                    className={`px-2 py-1 rounded text-[10px] font-medium transition-smooth border ${
                      active
                        ? 'bg-surface-600 text-gray-200 border-surface-500'
                        : 'bg-surface-700/50 text-gray-600 border-surface-700 line-through'
                    }`}
                  >
                    {rating}
                  </button>
                );
              })}
            </div>
          </div>
        </CollapsibleSection>

        {/* === SECTION 4: People === */}
        <CollapsibleSection title="People" badge={peopleCount > 0 ? peopleCount : null}>
          <PersonAutocomplete
            label="Actor"
            placeholder="Search actors..."
            value={filters.actor || ''}
            onChange={(val) => handleChange('actor', val)}
            fetchSuggestions={fetchActorSuggestions}
          />
          <PersonAutocomplete
            label="Director"
            placeholder="Search directors..."
            value={filters.director || ''}
            onChange={(val) => handleChange('director', val)}
            fetchSuggestions={fetchDirectorSuggestions}
          />
        </CollapsibleSection>

        {/* === SECTION 5: Details === */}
        <CollapsibleSection title="Details" badge={detailsCount > 0 ? detailsCount : null}>
          {/* Year range */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              Year Range
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="From"
                value={filters.yearFrom || ''}
                onChange={(e) => handleChange('yearFrom', e.target.value ? parseInt(e.target.value) : null)}
                className="w-1/2 px-3 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent transition-smooth"
              />
              <input
                type="number"
                placeholder="To"
                value={filters.yearTo || ''}
                onChange={(e) => handleChange('yearTo', e.target.value ? parseInt(e.target.value) : null)}
                className="w-1/2 px-3 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent transition-smooth"
              />
            </div>
          </div>

          {/* Runtime range */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              Runtime (minutes)
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="Min"
                value={filters.minRuntime || ''}
                onChange={(e) => handleChange('minRuntime', e.target.value ? parseInt(e.target.value) : null)}
                className="w-1/2 px-3 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent transition-smooth"
              />
              <input
                type="number"
                placeholder="Max"
                value={filters.maxRuntime || ''}
                onChange={(e) => handleChange('maxRuntime', e.target.value ? parseInt(e.target.value) : null)}
                className="w-1/2 px-3 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent transition-smooth"
              />
            </div>
          </div>

          {/* Release Date Range */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">
              Release Date Range
            </label>
            <div className="flex gap-2">
              <input
                type="date"
                value={filters.releasedAfter || ''}
                onChange={(e) => handleChange('releasedAfter', e.target.value || null)}
                className="w-1/2 px-2 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 focus:outline-none focus:border-accent transition-smooth [color-scheme:dark]"
              />
              <input
                type="date"
                value={filters.releasedBefore || ''}
                onChange={(e) => handleChange('releasedBefore', e.target.value || null)}
                className="w-1/2 px-2 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 focus:outline-none focus:border-accent transition-smooth [color-scheme:dark]"
              />
            </div>
          </div>

          {/* Exclude Watched */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Exclude Watched
            </label>
            <button
              onClick={() => handleChange('excludeWatched', !filters.excludeWatched)}
              className={`relative w-10 h-5 rounded-full transition-smooth ${
                filters.excludeWatched ? 'bg-accent' : 'bg-surface-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
                  filters.excludeWatched ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>

          {/* Hide Disliked */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Hide Disliked
            </label>
            <button
              onClick={() => handleChange('hideDisliked', !filters.hideDisliked)}
              className={`relative w-10 h-5 rounded-full transition-smooth ${
                filters.hideDisliked ? 'bg-red-500' : 'bg-surface-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
                  filters.hideDisliked ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>

          {/* Liked Only */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Liked Only
            </label>
            <button
              onClick={() => {
                handleChange('likedOnly', !filters.likedOnly);
                // If enabling "liked only", disable "hide disliked" since it's redundant
                if (!filters.likedOnly) handleChange('hideDisliked', false);
              }}
              className={`relative w-10 h-5 rounded-full transition-smooth ${
                filters.likedOnly ? 'bg-green-500' : 'bg-surface-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
                  filters.likedOnly ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>
        </CollapsibleSection>

        {/* === SECTION 6: Presets === */}
        <CollapsibleSection title="Presets">
          {/* Saved presets list */}
          <SavedCriteriaManager onApply={handleApplyPreset} />

          {/* Save current criteria */}
          {!showSavePrompt ? (
            <button
              onClick={() => setShowSavePrompt(true)}
              className="w-full py-2 rounded-lg text-sm font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-smooth flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
              Save Current Filters
            </button>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                placeholder="Preset name..."
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveCriteria()}
                autoFocus
                className="w-full px-3 py-2 bg-surface-700 border border-amber-500/30 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent transition-smooth"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveCriteria}
                  disabled={!saveName.trim() || saveStatus === 'saving'}
                  className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-accent text-black hover:bg-accent-dark transition-smooth disabled:opacity-50"
                >
                  {saveStatus === 'saving' ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setShowSavePrompt(false);
                    setSaveName('');
                  }}
                  className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-surface-700 text-gray-400 hover:bg-surface-600 transition-smooth"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {saveStatus === 'saved' && (
            <p className="text-xs text-green-400 mt-1">Preset saved!</p>
          )}
          {saveStatus === 'error' && (
            <p className="text-xs text-red-400 mt-1">Failed to save preset</p>
          )}
        </CollapsibleSection>

        {/* Clear all */}
        {hasActiveFilters && (
          <button
            onClick={onClearAll}
            className="w-full py-2 rounded-lg text-sm font-medium text-red-400 bg-red-400/10 hover:bg-red-400/20 transition-smooth"
          >
            Clear All Filters
          </button>
        )}
      </div>
    </div>
  );
}
