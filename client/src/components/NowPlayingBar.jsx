import React, { useEffect, useState } from 'react';
import { getPlexSessions } from '../lib/api';

const POLL_MS = 8000;

function fmtProgress(viewOffset, duration) {
  if (!duration) return '';
  const pct = Math.min(100, Math.max(0, (viewOffset / duration) * 100));
  return `${Math.round(pct)}%`;
}

export default function NowPlayingBar() {
  const [sessions, setSessions] = useState([]);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      getPlexSessions()
        .then((d) => { if (alive) setSessions(d.sessions || []); })
        .catch(() => { if (alive) setSessions([]); });
    };
    tick();
    const i = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(i); };
  }, []);

  if (!sessions.length || hidden) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 glass border-t border-white/10 px-3 sm:px-5 py-2.5">
      <div className="max-w-7xl mx-auto flex items-center gap-3 overflow-x-auto">
        <span className="text-[10px] uppercase tracking-wider text-amber-400 font-bold flex-shrink-0">
          Now Playing
        </span>
        {sessions.map((s) => (
          <div key={s.sessionKey || s.ratingKey} className="flex items-center gap-2 flex-shrink-0 bg-white/[0.04] rounded-lg px-2.5 py-1.5 border border-white/10">
            {s.thumb ? (
              <img src={s.thumb} alt="" className="w-8 h-12 object-cover rounded" loading="lazy" />
            ) : (
              <div className="w-8 h-12 bg-surface-700 rounded flex items-center justify-center text-xs">🎬</div>
            )}
            <div className="text-xs">
              <div className="text-gray-100 font-medium truncate max-w-[180px]" title={s.title}>
                {s.grandparentTitle ? `${s.grandparentTitle} — ${s.title}` : s.title}
              </div>
              <div className="text-gray-400 truncate max-w-[180px]">
                {s.player?.title || s.player?.device || 'Plex'}
                {s.user?.title ? ` · ${s.user.title}` : ''}
                {s.duration ? ` · ${fmtProgress(s.viewOffset, s.duration)}` : ''}
                {s.player?.state ? ` · ${s.player.state}` : ''}
              </div>
            </div>
          </div>
        ))}
        <button
          onClick={() => setHidden(true)}
          className="ml-auto text-gray-500 hover:text-gray-200 text-xs flex-shrink-0"
          title="Hide until next refresh"
        >
          dismiss
        </button>
      </div>
    </div>
  );
}
