import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Header from './components/Header';
import FilterPanel from './components/FilterPanel';
import MediaGrid from './components/MediaGrid';
import SettingsModal from './components/SettingsModal';
import StatusBar from './components/StatusBar';
import NewAdditionsPanel from './components/NewAdditionsPanel';
import TrendingRow from './components/TrendingRow';
import Watchlist from './components/Watchlist';
import WatchLaterQueue from './components/WatchLaterQueue';
import RandomPick from './components/RandomPick';
import StatsPanel from './components/StatsPanel';
import StreamingBrowse from './components/StreamingBrowse';
import ShelfRows from './components/ShelfRows';
import AskBox from './components/AskBox';
import SwipeMatch from './components/SwipeMatch';
import DuplicatesFinder from './components/DuplicatesFinder';
import TonightMode from './components/TonightMode';
import NowPlayingBar from './components/NowPlayingBar';
import WatchOnDevicePicker from './components/WatchOnDevicePicker';
import CuratedViewPublisher from './components/CuratedViewPublisher';
import CuratedViewer from './components/CuratedViewer';
import DiscoveryRows from './components/DiscoveryRows';
import VoiceMicButton from './components/VoiceMicButton';
import Wrapped from './components/Wrapped';
import ExternalLists from './components/ExternalLists';
import HeroBillboard from './components/HeroBillboard';
import ServerPicker from './components/ServerPicker';
import { getServers, getLibraries, getLibraryItems, clearCache, getWatchlist, getQueueItems, getAllPersonalRatings, getUnseenAlertCount } from './lib/api';
import { ratingLookup, withRatingChange } from './lib/personal-ratings';

import { DEFAULT_FILTERS, applyLibraryFilters } from './lib/library-filters';
import { loadSession, saveSession, parseHash } from './lib/session';

export default function App() {
  const restored = useRef(loadSession()).current;

  const [items, setItems] = useState([]);
  const [libraries, setLibraries] = useState([]);
  const [selectedLibrary, setSelectedLibrary] = useState(restored.library || '');
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS, ...(restored.filters || {}) });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // Settings asks to be reopened after it restarts the app (the desktop
  // "let phones connect" switch), so the result is on screen after the reload.
  const [showSettings, setShowSettings] = useState(() => {
    try {
      const reopen = sessionStorage.getItem('heldover.reopenSettings') === '1';
      sessionStorage.removeItem('heldover.reopenSettings');
      return reopen;
    } catch {
      return false;
    }
  });
  const [initError, setInitError] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt] = useState(null);

  // New feature states
  const [showWatchlist, setShowWatchlist] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [showRandomPick, setShowRandomPick] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showStreaming, setShowStreaming] = useState(false);
  const [showSwipe, setShowSwipe] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [watchlistCount, setWatchlistCount] = useState(0);
  const [queueCount, setQueueCount] = useState(0);
  const [personalRatings, setPersonalRatings] = useState([]);
  const [showAlerts, setShowAlerts] = useState(false);
  const [unseenAlertCount, setUnseenAlertCount] = useState(0);

  // Six Big Swings state
  const [showTonight, setShowTonight] = useState(false);
  const [showPublisher, setShowPublisher] = useState(false);
  const [showLists, setShowLists] = useState(false);
  const [showServerPicker, setShowServerPicker] = useState(false);
  const [watchOnDeviceItem, setWatchOnDeviceItem] = useState(null);
  const [route, setRoute] = useState(() => parseHash(typeof window !== 'undefined' ? window.location.hash : ''));

  // Fetch watchlist count
  useEffect(() => {
    getWatchlist()
      .then((data) => {
        const items = Array.isArray(data) ? data : data.items || [];
        setWatchlistCount(items.length);
      })
      .catch(() => {});
  }, [showWatchlist]);

  // Fetch queue count
  useEffect(() => {
    getQueueItems()
      .then((data) => {
        const items = data.items || [];
        setQueueCount(items.length);
      })
      .catch(() => {});
  }, [showQueue]);

  // Fetch unseen alert count
  useEffect(() => {
    getUnseenAlertCount()
      .then((data) => setUnseenAlertCount(data.count || 0))
      .catch(() => {});
  }, [showAlerts]);

  // Fetch personal ratings and merge into items
  useEffect(() => {
    getAllPersonalRatings()
      .then((data) => setPersonalRatings(data.ratings || []))
      .catch(() => {});
  }, []);

  // Hash router for shareable views + Wrapped
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  // Load libraries on mount
  useEffect(() => {
    async function init() {
      try {
        const data = await getLibraries();
        const list = data.libraries || data || [];
        setLibraries(list);

        // The library we reopened on may not be there any more — these are
        // other people's servers, and one can stop sharing between visits.
        // Sitting on a selection that no longer exists shows an empty grid with
        // no explanation, so fall back to the front page instead.
        const remembered = loadSession().library;
        if (remembered) {
          const [sk, lk] = remembered.split(':');
          const stillThere = list.some((l) => l.serverKey === sk && l.key === lk);
          // A server that is down or backed off right now is listed as a
          // warning, not left out for good. Forgetting the library on that
          // basis lost it permanently over a two-minute outage.
          const serverJustUnreachable = (data.warnings || []).some((w) => w.serverKey === sk);
          if (!stillThere && !serverJustUnreachable) {
            setSelectedLibrary('');
            saveSession({ library: '', scrollY: 0 });
          }
        }
      } catch (err) {
        console.error('Failed to load libraries:', err);
        setInitError(err.message || 'Failed to connect. Check your settings.');
      }
    }
    init();
  }, []);

  // Put you back roughly where you were, once there is something to scroll.
  // Only on the first load after a restart: doing it on every change would
  // yank the page around while you are using it.
  const scrollRestored = useRef(false);
  useEffect(() => {
    if (scrollRestored.current) return;
    if (!restored.scrollY || items.length === 0) return;
    scrollRestored.current = true;
    // After paint, or the page is still short and the scroll goes nowhere.
    requestAnimationFrame(() => window.scrollTo(0, restored.scrollY));
  }, [items, restored.scrollY]);

  // Fetch items when library changes
  useEffect(() => {
    if (!selectedLibrary) {
      setItems([]);
      return;
    }
    const [serverKey, libraryKey] = selectedLibrary.split(':');
    if (!serverKey || !libraryKey) return;

    setLoading(true);
    setError('');

    // Pick library A, then B before A has answered, and A can land last and
    // paint its titles under B's name. Everything downstream then addresses
    // the wrong server: casting to the TV and downloads use B's server with
    // A's item ids. The flag says "this request is no longer the current one",
    // and a stale answer is dropped rather than shown.
    let current = true;

    getLibraryItems(serverKey, libraryKey)
      .then((data) => {
        if (!current) return;
        setItems(data.items || data);
        setFromCache(!!data.fromCache);
        setCachedAt(data.cachedAt || null);
        setLoading(false);
      })
      .catch((err) => {
        if (!current) return;
        console.error('Failed to load library:', err);
        setError(err.message || 'Failed to load library');
        setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [selectedLibrary]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't fire shortcuts when typing in inputs
      const tag = e.target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      switch (e.key.toLowerCase()) {
        case 'w':
          setShowWatchlist((prev) => !prev);
          break;
        case 'q':
          setShowQueue((prev) => !prev);
          break;
        case 'r':
          if (selectedLibrary) setShowRandomPick((prev) => !prev);
          break;
        case 's':
          if (selectedLibrary) setShowStats((prev) => !prev);
          break;
        case 'n':
          setShowAlerts((prev) => !prev);
          break;
        case 't':
          if (selectedLibrary) setShowTonight((prev) => !prev);
          break;
        case 'p':
          if (selectedLibrary) setShowPublisher((prev) => !prev);
          break;
        case 'l':
          setShowLists((prev) => !prev);
          break;
        case 'v':
          setShowServerPicker((prev) => !prev);
          break;
        case '/':
          e.preventDefault();
          // Focus the search input in the filter panel
          const searchInput = document.querySelector('[data-search-input]');
          if (searchInput) searchInput.focus();
          break;
        case 'escape':
          // Close in priority order
          if (watchOnDeviceItem) setWatchOnDeviceItem(null);
          else if (showServerPicker) setShowServerPicker(false);
          else if (showLists) setShowLists(false);
          else if (showPublisher) setShowPublisher(false);
          else if (showTonight) setShowTonight(false);
          else if (showRandomPick) setShowRandomPick(false);
          else if (showAlerts) setShowAlerts(false);
          else if (showDuplicates) setShowDuplicates(false);
          else if (showQueue) setShowQueue(false);
          else if (showStreaming) setShowStreaming(false);
          else if (showWatchlist) setShowWatchlist(false);
          else if (showStats) setShowStats(false);
          else if (showFilters) setShowFilters(false);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedLibrary, showRandomPick, showAlerts, showDuplicates, showQueue, showWatchlist, showStats, showFilters, showTonight, showPublisher, showLists, showServerPicker, watchOnDeviceItem, showStreaming]);

  // Extract genres from loaded items
  const genres = useMemo(() => {
    const genreSet = new Set();
    items.forEach((item) => {
      (item.genres || []).forEach((g) => genreSet.add(g));
    });
    return Array.from(genreSet).sort();
  }, [items]);

  // Get current library name
  const libraryName = useMemo(() => {
    if (!selectedLibrary) return '';
    const [serverKey, libraryKey] = selectedLibrary.split(':');
    const lib = libraries.find((l) => l.serverKey === serverKey && l.key === libraryKey);
    if (!lib) return '';
    return `${lib.serverName || 'Server'} > ${lib.title}`;
  }, [selectedLibrary, libraries]);

  // Merge personal ratings into items. A thumb belongs to one server's title:
  // the same item number on another server is a different film.
  const mergedItems = useMemo(() => {
    if (personalRatings.length === 0) return items;
    const ratingFor = ratingLookup(personalRatings);
    const libraryServer = selectedLibrary ? selectedLibrary.split(':')[0] : '';
    return items.map((item) => {
      const pr = ratingFor(item, libraryServer);
      if (pr) return { ...item, personalRating: pr };
      return item;
    });
  }, [items, personalRatings, selectedLibrary]);

  // Handler for when a rating changes from a card
  const handleRatingChange = useCallback((plexKey, rating, item) => {
    const libraryServer = selectedLibrary ? selectedLibrary.split(':')[0] : '';
    setPersonalRatings((prev) => withRatingChange(prev, item, libraryServer, rating));
  }, [selectedLibrary]);

  // Apply filters (the rules live in lib/library-filters.js)
  const filteredItems = useMemo(() => applyLibraryFilters(mergedItems, filters), [mergedItems, filters]);

  const handleClearAll = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  const handleSelectLibrary = useCallback((value) => {
    setSelectedLibrary(value);
    setFilters(DEFAULT_FILTERS);
    saveSession({ library: value, filters: DEFAULT_FILTERS, scrollY: 0 });
  }, []);

  // Filters are saved as they change, but the library is saved only when it is
  // chosen: writing it here too would overwrite a good value with the empty
  // one on the very first render.
  useEffect(() => {
    saveSession({ filters });
  }, [filters]);

  // Roughly where you had scrolled to. Recorded while idle rather than on every
  // pixel of movement, so scrolling stays smooth.
  useEffect(() => {
    let pending = null;
    const onScroll = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        saveSession({ scrollY: Math.round(window.scrollY) });
      }, 400);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (pending) clearTimeout(pending);
    };
  }, []);

  const [serverKey, libraryKey] = selectedLibrary ? selectedLibrary.split(':') : ['', ''];

  const handleTonightPick = useCallback((item) => {
    setShowTonight(false);
    setWatchOnDeviceItem(item);
  }, []);

  const handleVoiceParsed = useCallback((parsed) => {
    if (!parsed || !parsed.filters) return;
    setFilters((prev) => ({
      ...prev,
      ...(parsed.filters.genres ? { genres: parsed.filters.genres } : {}),
      ...(parsed.filters.minRating != null ? { minImdb: parsed.filters.minRating } : {}),
      ...(parsed.filters.maxRuntime != null ? { maxRuntime: parsed.filters.maxRuntime } : {}),
      ...(parsed.filters.minRuntime != null ? { minRuntime: parsed.filters.minRuntime } : {}),
      ...(parsed.filters.yearFrom != null ? { yearFrom: parsed.filters.yearFrom } : {}),
      ...(parsed.filters.yearTo != null ? { yearTo: parsed.filters.yearTo } : {}),
      ...(parsed.filters.actor ? { actor: parsed.filters.actor } : {}),
      ...(parsed.filters.type ? { mediaType: parsed.filters.type } : {}),
    }));
  }, []);

  if (route.kind === 'view') {
    return (
      <>
        <CuratedViewer
          slug={route.slug}
          onItemClick={(item) => setWatchOnDeviceItem(item)}
          onLeave={() => { window.location.hash = ''; }}
        />
        {watchOnDeviceItem && (
          <WatchOnDevicePicker
            item={watchOnDeviceItem}
            serverKey={watchOnDeviceItem.serverKey || serverKey}
            onClose={() => setWatchOnDeviceItem(null)}
          />
        )}
        <NowPlayingBar />
      </>
    );
  }
  if (route.kind === 'wrapped') {
    return (
      <>
        <Wrapped
          serverKey={serverKey}
          libraryKey={libraryKey}
          onLeave={() => { window.location.hash = ''; }}
        />
        <NowPlayingBar />
      </>
    );
  }

  return (
    <div className="min-h-screen">
      <Header
        totalCount={mergedItems.length}
        filteredCount={filteredItems.length}
        libraryName={libraryName}
        onToggleFilters={() => setShowFilters((prev) => !prev)}
        showFilters={showFilters}
        onToggleWatchlist={() => setShowWatchlist(true)}
        watchlistCount={watchlistCount}
        onToggleQueue={() => setShowQueue(true)}
        queueCount={queueCount}
        onRandomPick={() => setShowRandomPick(true)}
        hasLibrary={!!selectedLibrary}
        unseenAlertCount={unseenAlertCount}
        showAlerts={showAlerts}
        onToggleAlerts={() => setShowAlerts((prev) => !prev)}
        onToggleStreaming={() => setShowStreaming(true)}
        onToggleSwipe={() => setShowSwipe(true)}
      />

      {/* Status bar */}
      <StatusBar />

      <div className="flex relative">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block fixed top-[57px] left-0 bottom-0 z-30">
          <FilterPanel
            libraries={libraries}
            selectedLibrary={selectedLibrary}
            onSelectLibrary={handleSelectLibrary}
            filters={filters}
            onFilterChange={setFilters}
            genres={genres}
            onClearAll={handleClearAll}
          />
        </aside>

        {/* Mobile filter drawer */}
        {showFilters && (
          <>
            <div
              className="lg:hidden fixed inset-0 z-40 bg-black/60"
              onClick={() => setShowFilters(false)}
            />
            <aside className="lg:hidden fixed top-0 right-0 bottom-0 z-50 w-[300px] max-w-[85vw] shadow-2xl">
              <FilterPanel
                libraries={libraries}
                selectedLibrary={selectedLibrary}
                onSelectLibrary={(v) => {
                  handleSelectLibrary(v);
                  setShowFilters(false);
                }}
                filters={filters}
                onFilterChange={setFilters}
                genres={genres}
                onClearAll={handleClearAll}
                isMobile
                onClose={() => setShowFilters(false)}
              />
            </aside>
          </>
        )}

        {/* Main content */}
        {/*
          `min-w-0` is doing real work here. A flex item refuses by default to
          shrink below the width of its own contents, and the contents include
          rows of a hundred fixed-width posters. So this column grew to 11,522
          pixels on a 390 pixel phone: the poster rows never scrolled, because
          they were never asked to fit — the whole page slid sideways instead.
          Allowing the column to be narrower than its contents is what lets the
          rows inside it scroll on their own, the way they were written to.
        */}
        <main className="flex-1 min-w-0 lg:ml-[280px] p-4 sm:p-6">
          {/* Toolbar */}
          <div className="flex items-center justify-end gap-2 mb-4">
            {/* Tonight Mode */}
            {selectedLibrary && (
              <button
                onClick={() => setShowTonight(true)}
                className="px-3 py-2 rounded-lg bg-amber-400 text-black text-sm font-semibold hover:bg-amber-300 transition-smooth"
                title="Tonight (T) — mood-based picks"
              >
                <span className="hidden sm:inline">🌙 </span>Tonight
              </button>
            )}

            {/* Publish curated view */}
            {selectedLibrary && (
              <button
                onClick={() => setShowPublisher(true)}
                className="p-2 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-amber-400 transition-smooth"
                title="Publish current filter as a shareable view (P)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
              </button>
            )}

            {/* Wrapped */}
            {selectedLibrary && (
              <button
                onClick={() => { window.location.hash = 'wrapped'; }}
                className="p-2 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-amber-400 transition-smooth"
                title="Heldover Wrapped"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.657-1.79 3-4 3s-4-1.343-4-3 1.79-3 4-3 4 1.343 4 3zm12-3c0 1.657-1.79 3-4 3s-4-1.343-4-3 1.79-3 4-3 4 1.343 4 3z" />
                </svg>
              </button>
            )}

            {/* Servers — health + library picker */}
            <button
              onClick={() => setShowServerPicker(true)}
              className="p-2 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-amber-400 transition-smooth"
              title="Servers — health & library picker (V)"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </button>

            {/* Browse external lists (MDBList / TMDB / Letterboxd / Trakt) */}
            <button
              onClick={() => setShowLists(true)}
              className="p-2 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-amber-400 transition-smooth"
              title="Browse lists from MDBList / TMDB / Letterboxd / Trakt (L)"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10M4 18h10" />
              </svg>
            </button>

            {/* Voice mic */}
            {selectedLibrary && <VoiceMicButton onParsed={handleVoiceParsed} />}

            {fromCache && cachedAt && (
              <span className="text-xs text-gray-500">
                Cached {new Date(cachedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}

            {/* Stats toggle */}
            {selectedLibrary && (
              <button
                onClick={() => setShowStats((prev) => !prev)}
                className={`group relative p-2 rounded-lg transition-smooth ${
                  showStats
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'hover:bg-surface-700 text-gray-500 hover:text-amber-400'
                }`}
                title="Library Stats (S)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[9px] bg-surface-700 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                  Press S
                </span>
              </button>
            )}

            {/* Duplicates */}
            <button
              onClick={() => setShowDuplicates(true)}
              className="group relative p-2 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-amber-400 transition-smooth"
              title="Find Duplicates"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>

            {selectedLibrary && (
              <button
                onClick={() => {
                  const [sk, lk] = selectedLibrary.split(':');
                  setLoading(true);
                  getLibraryItems(sk, lk, { refresh: true })
                    .then((data) => {
                      setItems(data.items || data);
                      setFromCache(false);
                      setCachedAt(null);
                      setLoading(false);
                    })
                    .catch(() => setLoading(false));
                }}
                disabled={loading}
                className="p-2 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-green-400 transition-smooth disabled:opacity-50"
                title="Refresh from Plex (bypass cache)"
              >
                <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setShowSettings(true)}
              className="p-2 rounded-lg hover:bg-surface-700 text-gray-500 hover:text-accent transition-smooth"
              title="Settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>

          {/* Netflix-style hero billboard */}
          {selectedLibrary && mergedItems.length > 0 && (
            <HeroBillboard
              items={mergedItems}
              onPlay={(item) => setWatchOnDeviceItem(item)}
              onMoreInfo={(item) => {
                /* Open detail modal via existing flow if available; for now route through Watch-on-Device picker */
                setWatchOnDeviceItem(item);
              }}
            />
          )}

          {/* New Additions panel */}
          {!selectedLibrary && (
            <>
              <AskBox onPick={(item) => setWatchOnDeviceItem(item)} />
              <ShelfRows onPick={(item) => setWatchOnDeviceItem(item)} />
            </>
          )}

          <NewAdditionsPanel onPick={(item) => setWatchOnDeviceItem(item)} />

          {/* Trending rows */}
          <TrendingRow />

          {/* Personalized discovery rows */}
          {selectedLibrary && (
            <DiscoveryRows
              serverKey={serverKey}
              libraryKey={libraryKey}
              onItemClick={(item) => setWatchOnDeviceItem(item)}
            />
          )}

          {/* Stats panel (toggleable) */}
          {showStats && selectedLibrary && (
            <StatsPanel
              serverKey={serverKey}
              libraryKey={libraryKey}
              onClose={() => setShowStats(false)}
            />
          )}

          {/* Init error / welcome state */}
          {initError && !selectedLibrary && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-full bg-red-400/10 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-300 mb-2">Connection Error</h3>
              <p className="text-sm text-gray-500 mb-4 max-w-md">{initError}</p>
              <button
                onClick={() => setShowSettings(true)}
                className="px-4 py-2 rounded-lg bg-accent text-black font-medium text-sm hover:bg-accent-dark transition-smooth"
              >
                Open Settings
              </button>
            </div>
          )}

          {!initError && !selectedLibrary && !loading && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <span className="text-6xl mb-4">🎬</span>
              <h2 className="text-2xl font-bold text-gray-200 mb-2">Welcome to Heldover</h2>
              <p className="text-gray-500 max-w-md">
                Select a library from the {' '}
                <span className="hidden lg:inline">sidebar</span>
                <span className="lg:hidden">filter menu</span>
                {' '} to browse your media and filter by ratings.
              </p>
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-red-400/10 border border-red-400/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Media grid */}
          {selectedLibrary && <MediaGrid items={filteredItems} loading={loading} serverKey={serverKey} onRatingChange={handleRatingChange} onPlayOnTv={(item) => setWatchOnDeviceItem({ ...item, serverKey: item.serverKey || serverKey })} />}
        </main>
      </div>

      {/* Settings modal */}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      {/* Watchlist full-page view */}
      {showWatchlist && <Watchlist onClose={() => setShowWatchlist(false)} />}

      {showSwipe && (
        <SwipeMatch
          onClose={() => setShowSwipe(false)}
          onPlay={(item) => {
            setShowSwipe(false);
            setWatchOnDeviceItem(item);
          }}
        />
      )}

      {showStreaming && (
        <StreamingBrowse
          onClose={() => setShowStreaming(false)}
          onPlayOnTv={(libraryItem) => {
            setShowStreaming(false);
            setWatchOnDeviceItem(libraryItem);
          }}
        />
      )}

      {/* Watch Later Queue */}
      {showQueue && <WatchLaterQueue onClose={() => setShowQueue(false)} />}

      {/* Random Pick overlay */}
      {showRandomPick && selectedLibrary && (
        <RandomPick
          serverKey={serverKey}
          libraryKey={libraryKey}
          filters={filters}
          onClose={() => setShowRandomPick(false)}
        />
      )}

      {/* Duplicates finder */}
      {showDuplicates && <DuplicatesFinder onClose={() => setShowDuplicates(false)} />}

      {/* Tonight Mode */}
      {showTonight && selectedLibrary && (
        <TonightMode
          serverKey={serverKey}
          libraryKey={libraryKey}
          onClose={() => setShowTonight(false)}
          onPickItem={handleTonightPick}
        />
      )}

      {/* Publish a curated view */}
      {showPublisher && selectedLibrary && (
        <CuratedViewPublisher
          filters={filters}
          serverKey={serverKey}
          libraryKey={libraryKey}
          onClose={() => setShowPublisher(false)}
        />
      )}

      {/* Watch on Device picker */}
      {watchOnDeviceItem && (
        <WatchOnDevicePicker
          item={watchOnDeviceItem}
          serverKey={serverKey}
          onClose={() => setWatchOnDeviceItem(null)}
        />
      )}

      {/* External Lists browser */}
      {showLists && (
        <ExternalLists
          serverKey={serverKey || null}
          libraryKey={libraryKey || null}
          onClose={() => setShowLists(false)}
          onPickInLibrary={(libraryItem) => {
            setShowLists(false);
            setWatchOnDeviceItem(libraryItem);
          }}
        />
      )}

      {/* Server picker — health + library selection */}
      {showServerPicker && (
        <ServerPicker
          selectedLibrary={selectedLibrary}
          onSelect={(value) => {
            handleSelectLibrary(value);
            setShowServerPicker(false);
          }}
          onClose={() => setShowServerPicker(false)}
        />
      )}

      {/* Now Playing persistent bar */}
      <NowPlayingBar />
    </div>
  );
}
