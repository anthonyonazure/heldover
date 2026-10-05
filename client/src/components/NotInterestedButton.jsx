import React, { useState } from 'react';
import { markNotInterested } from '../lib/api';

// `serverKey` is the Plex server the item is on, for items that do not carry
// their own. A title is hidden per server: the same item number is a
// different film on another server.
export default function NotInterestedButton({ item, serverKey, onMarked, compact = false }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const onClick = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (busy || done) return;
    setBusy(true);
    try {
      await markNotInterested({
        plex_key: item.ratingKey || item.plex_key || item.plexKey,
        serverKey: item.serverKey || serverKey,
        title: item.title,
        year: item.year,
        type: item.type,
      });
      setDone(true);
      onMarked && onMarked(item);
    } finally {
      setBusy(false);
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={done ? 'Won’t show again' : 'Not interested'}
        className={`p-1.5 rounded-md transition-colors ${
          done ? 'text-green-400' : 'text-gray-400 hover:text-red-400 hover:bg-black/30'
        }`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
        done ? 'bg-green-900/40 text-green-300 border border-green-800' : 'bg-surface-800 text-gray-300 hover:bg-surface-700 border border-surface-700'
      }`}
    >
      {done ? '✓ Won’t show again' : 'Not interested'}
    </button>
  );
}
