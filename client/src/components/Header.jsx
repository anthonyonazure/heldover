import React, { useState } from 'react';
import DownloadManager from './DownloadManager';
import AlertsPanel from './AlertsPanel';
import ProfileSwitcher from './ProfileSwitcher';
import SkinSwitcher from './SkinSwitcher';

export default function Header({
  totalCount,
  filteredCount,
  libraryName,
  onToggleFilters,
  showFilters,
  onToggleWatchlist,
  watchlistCount,
  onToggleQueue,
  queueCount,
  onRandomPick,
  hasLibrary,
  unseenAlertCount,
  showAlerts,
  onToggleAlerts,
  onToggleStreaming,
  onToggleSwipe,
}) {
  return (
    <header className="sticky top-0 z-40 glass border-b border-white/5">
      <div className="flex items-center justify-between gap-2 px-4 py-3 lg:pl-[296px]">
        {/* The title block gives way first: on a phone only the icon stays,
            because the controls cannot be reached if they are pushed off the
            edge. The name used to stay at full width underneath them, so the
            first buttons sat on top of it. */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-2xl" role="img" aria-label="film">
            🎬
          </span>
          <div className="hidden sm:block">
            <h1 className="text-lg font-extrabold text-gradient-amber tracking-tight">Heldover</h1>
            {libraryName && (
              <p className="text-xs text-gray-400">
                {libraryName}
                {totalCount > 0 && (
                  <span className="ml-2">
                    Showing {filteredCount} of {totalCount}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        {/* On a narrow phone this row of controls came to 454px against a 390px
            screen, so whatever sat at the end was simply off the display with no
            way to reach it. It now scrolls sideways on its own rather than
            pushing the page out of shape. */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar min-w-0">
          <SkinSwitcher />
          <ProfileSwitcher />

          {/* Couples swipe */}
          <button
            onClick={onToggleSwipe}
            className="group flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-pink-400 transition-smooth"
            title="Both of you pick together"
          >
            <span className="text-lg">💘</span>
            <span className="text-sm hidden sm:inline">Both</span>
          </button>

          {/* Streaming services browse */}
          <button
            onClick={onToggleStreaming}
            className="group flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-red-400 transition-smooth"
            title="Browse Netflix and other streaming services"
          >
            <span className="text-lg">📺</span>
            <span className="text-sm hidden sm:inline">Streaming</span>
          </button>

          {/* Random Pick button */}
          {hasLibrary && (
            <button
              onClick={onRandomPick}
              className="group relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-amber-400 transition-smooth"
              title="Random Pick (R)"
            >
              <span className="text-lg group-hover:animate-bounce">🎲</span>
              <span className="text-sm hidden sm:inline">Pick</span>
              <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[9px] bg-surface-700 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                Press R
              </span>
            </button>
          )}

          {/* Watchlist button */}
          <button
            onClick={onToggleWatchlist}
            className="group relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-amber-400 transition-smooth"
            title="Watchlist (W)"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 3a1 1 0 011-1h12a1 1 0 011 1v18.143a.5.5 0 01-.766.424L12 17.03l-6.234 4.536A.5.5 0 015 21.143V3z" />
            </svg>
            {watchlistCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center px-1 rounded-full text-[9px] font-bold bg-amber-500 text-black">
                {watchlistCount > 99 ? '99+' : watchlistCount}
              </span>
            )}
            <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[9px] bg-surface-700 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
              Press W
            </span>
          </button>

          {/* Queue button */}
          <button
            onClick={onToggleQueue}
            className="group relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-[#06B6D4] transition-smooth"
            title="Watch Later Queue (Q)"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {queueCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center px-1 rounded-full text-[9px] font-bold bg-[#06B6D4] text-black">
                {queueCount > 99 ? '99+' : queueCount}
              </span>
            )}
            <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[9px] bg-surface-700 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
              Press Q
            </span>
          </button>

          {/* Alerts (Subscriptions) */}
          <div className="relative">
            <button
              onClick={onToggleAlerts}
              className="group relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-teal-400 transition-smooth"
              title="Episode Alerts (N)"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              {unseenAlertCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center px-1 rounded-full text-[9px] font-bold bg-red-500 text-white">
                  {unseenAlertCount > 99 ? '99+' : unseenAlertCount}
                </span>
              )}
              <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[9px] bg-surface-700 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                Press N
              </span>
            </button>
            {showAlerts && <AlertsPanel onClose={onToggleAlerts} />}
          </div>

          {/* Download Manager */}
          <DownloadManager />

          {/* Mobile filter toggle */}
          <button
            onClick={onToggleFilters}
            className="lg:hidden flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-700 hover:bg-surface-600 transition-smooth"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              {showFilters ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              )}
            </svg>
            <span className="text-sm">{showFilters ? 'Close' : 'Filters'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
