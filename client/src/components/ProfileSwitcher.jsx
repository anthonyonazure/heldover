import React, { useEffect, useState } from 'react';
import { getProfiles, createProfile } from '../lib/api';
import { getProfileId, setProfileId } from '../lib/profile';

/**
 * Who is watching. Switching reloads the app, because thumbs, hidden titles and
 * the queue all change with the person — patching them into place one by one
 * would leave the screen showing a mix of two people's opinions.
 */
export default function ProfileSwitcher() {
  const [profiles, setProfiles] = useState([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const activeId = getProfileId();

  useEffect(() => {
    getProfiles()
      .then((d) => setProfiles(d.profiles || []))
      .catch(() => setProfiles([]));
  }, []);

  const active = profiles.find((p) => p.id === activeId) || profiles[0];

  const choose = (profile) => {
    if (profile.id === activeId) {
      setOpen(false);
      return;
    }
    setProfileId(profile.id);
    window.location.reload();
  };

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const { profile } = await createProfile(name);
      setProfiles((prev) => [...prev, profile]);
      setNewName('');
      setAdding(false);
      choose(profile);
    } catch {
      setAdding(false);
    }
  };

  if (profiles.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-300 transition-smooth"
        title="Who is watching"
      >
        <span
          className="w-6 h-6 rounded-full flex items-center justify-center text-xs"
          style={{ backgroundColor: active?.color || '#F59E0B' }}
        >
          {active?.emoji || '🍿'}
        </span>
        <span className="text-sm hidden sm:inline">{active?.name}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-56 glass rounded-xl shadow-2xl border border-white/5 p-2">
            <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-gray-500">Who is watching</p>
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => choose(p)}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-smooth ${
                  p.id === activeId ? 'bg-surface-700 text-gray-100' : 'hover:bg-surface-800 text-gray-300'
                }`}
              >
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center text-sm"
                  style={{ backgroundColor: p.color || '#F59E0B' }}
                >
                  {p.emoji || '🍿'}
                </span>
                <span className="text-sm font-medium">{p.name}</span>
                {p.id === activeId && <span className="ml-auto text-[10px] text-accent">active</span>}
              </button>
            ))}

            {adding ? (
              <div className="flex gap-1 mt-1 px-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && add()}
                  placeholder="Name"
                  className="flex-1 min-w-0 px-2 py-1.5 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 focus:outline-none focus:border-accent"
                />
                <button onClick={add} className="px-2 py-1.5 rounded-lg bg-accent text-black text-xs font-bold">
                  Add
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="w-full px-2 py-2 mt-1 rounded-lg text-left text-sm text-gray-400 hover:bg-surface-800 hover:text-gray-200 transition-smooth"
              >
                + Add someone
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
