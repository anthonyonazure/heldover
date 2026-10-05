import React, { useState } from 'react';
import { claimOwner } from '../lib/setup';

/**
 * Proves this device belongs to whoever runs Heldover, by entering the
 * settings code (printed in its log, and shown in Settings on the computer it
 * runs on). Only the owner can change settings, so a
 * guest on the Wi-Fi cannot relink Plex, change keys, or lock anyone out.
 */
export default function OwnerClaim({ onClaimed, compact = false }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await claimOwner(code);
      onClaimed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className={`text-gray-400 ${compact ? 'text-xs' : 'text-sm'}`}>
        Enter the settings code. Heldover prints it every time it starts: in a terminal, or with{' '}
        <code className="text-gray-300">docker logs heldover</code>. In the desktop app it is shown in Settings, on
        the computer the app runs on.
      </p>
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX"
          maxLength={9}
          autoCapitalize="characters"
          className="flex-1 min-w-0 px-3 py-2.5 bg-surface-800 border border-surface-600 rounded-lg text-center tracking-[0.25em] text-gray-100 placeholder-gray-600 focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || code.replace(/[^A-Z0-9]/g, '').length < 8}
          className="shrink-0 px-4 py-2.5 rounded-lg bg-accent text-black font-bold disabled:opacity-40"
        >
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </div>
      {error && <p className="text-sm text-amber-300">{error}</p>}
    </form>
  );
}
