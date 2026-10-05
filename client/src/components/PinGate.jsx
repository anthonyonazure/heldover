import React, { useState } from 'react';
import { enterPin } from '../lib/setup';

/** Asked once per device when the owner has set an access PIN. */
export default function PinGate({ onUnlocked }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await enterPin(pin);
      onUnlocked();
    } catch (err) {
      setError(err.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-900 px-4">
      <form onSubmit={submit} className="w-full max-w-xs space-y-4 text-center">
        <p className="text-4xl">🎬</p>
        <h1 className="text-xl font-extrabold text-gray-100">Heldover</h1>
        <p className="text-sm text-gray-400">Enter the PIN to continue. This device will remember it.</p>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          autoFocus
          maxLength={12}
          placeholder="PIN"
          className="w-full px-4 py-3 bg-surface-800 border border-surface-600 rounded-xl text-center tracking-[0.4em] text-lg text-gray-100 placeholder-gray-600 focus:outline-none focus:border-accent"
        />
        {error && <p className="text-sm text-amber-300">{error}</p>}
        <button
          type="submit"
          disabled={busy || pin.length < 6}
          className="w-full py-3 rounded-xl bg-accent text-black font-bold disabled:opacity-40"
        >
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
