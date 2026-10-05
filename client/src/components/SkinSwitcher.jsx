import React, { useEffect, useState } from 'react';

const SKINS = [
  { id: 'default', label: 'Heldover', swatch: '#f5c518' },
  { id: 'netflix', label: 'Netflix', swatch: '#e50914' },
];

const STORAGE_KEY = 'heldover.skin';

export function applyStoredSkin() {
  try {
    const skin = localStorage.getItem(STORAGE_KEY);
    if (skin && skin !== 'default') document.documentElement.setAttribute('data-skin', skin);
  } catch {
    // Blocked site data just means the default look.
  }
}

/** Swap the whole look without touching a single component. */
export default function SkinSwitcher() {
  const [skin, setSkin] = useState('default');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setSkin(localStorage.getItem(STORAGE_KEY) || 'default');
    } catch {
      setSkin('default');
    }
  }, []);

  const choose = (id) => {
    setSkin(id);
    setOpen(false);
    if (id === 'default') document.documentElement.removeAttribute('data-skin');
    else document.documentElement.setAttribute('data-skin', id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // The look still changes; it just will not be remembered.
    }
  };

  const active = SKINS.find((s) => s.id === skin) || SKINS[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-400 transition-smooth"
        title="Change the look"
      >
        <span className="w-4 h-4 rounded-full border border-white/20" style={{ backgroundColor: active.swatch }} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-44 glass rounded-xl shadow-2xl border border-white/5 p-2">
            <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-gray-500">Look</p>
            {SKINS.map((s) => (
              <button
                key={s.id}
                onClick={() => choose(s.id)}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-smooth ${
                  s.id === skin ? 'bg-surface-700 text-gray-100' : 'hover:bg-surface-800 text-gray-300'
                }`}
              >
                <span className="w-4 h-4 rounded-full border border-white/20" style={{ backgroundColor: s.swatch }} />
                <span className="text-sm">{s.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
