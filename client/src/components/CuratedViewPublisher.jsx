import React, { useState } from 'react';
import { createCuratedView } from '../lib/api';

export default function CuratedViewPublisher({ filters, serverKey, libraryKey, onClose }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    // The server asks the same of a new edit PIN; said here first so the
    // person is not sent away and back for it.
    if (pin.trim() && pin.trim().length < 4) {
      setError('The edit PIN needs 4 or more characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createCuratedView({
        name: name.trim(),
        description: description.trim() || undefined,
        filters,
        serverKey,
        libraryKey,
        editPin: pin.trim() || undefined,
      });
      setResult(res.view);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const url = result ? `${window.location.origin}/#view/${result.slug}` : '';

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-white/5">
          <h3 className="text-lg font-bold text-gray-50">Publish view</h3>
          <p className="text-xs text-gray-400 mt-1">Bundle the current filters into a sharable link.</p>
        </div>

        {result ? (
          <div className="p-5 space-y-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Shareable URL</div>
              <div className="flex gap-2">
                <input readOnly value={url} className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-xs text-gray-100" />
                <button onClick={copy} className="px-3 py-2 rounded-lg bg-amber-400 text-black text-xs font-semibold hover:bg-amber-300">Copy</button>
              </div>
            </div>
            <div className="text-xs text-gray-400">
              Anyone with this link sees only your curated picks — no filter UI, no scope to wander.
              {result.has_pin && ' Edit access is PIN-locked.'}
            </div>
            <button onClick={onClose} className="w-full mt-3 px-4 py-2 rounded-lg bg-surface-700 text-gray-200 hover:bg-surface-600">Done</button>
          </div>
        ) : (
          <form onSubmit={submit} className="p-5 space-y-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-gray-400">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="For Dad / Halloween 31 / Movie Night"
                required
                className="mt-1 w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-gray-400">Description (optional)</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What's this view for?"
                className="mt-1 w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-gray-400">Edit PIN (optional)</span>
              <input
                type="text"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="Lock who can edit / delete (4 or more characters)"
                className="mt-1 w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              />
            </label>
            {error && <div className="text-xs text-amber-300">{error}</div>}
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-lg bg-surface-700 text-gray-200 hover:bg-surface-600">Cancel</button>
              <button type="submit" disabled={busy} className="flex-1 px-4 py-2 rounded-lg bg-amber-400 text-black font-semibold hover:bg-amber-300 disabled:opacity-50">
                {busy ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
