import React, { useEffect, useRef, useState } from 'react';
import { getTvDevices, playOnTv, controlTv, getTrailer } from '../lib/api';

/**
 * "Watch on…" — sends a title straight to the TV.
 *
 * This used to drive Plex's remote control, which needs a Plex app signed into
 * your account and advertising itself. On shared servers that basically never
 * happens, so the list was always empty. It now casts over DLNA instead: the TV
 * fetches and plays the stream itself, with nothing installed on it.
 *
 * Picking a poster is not always a decision to watch it. Often it is a question
 * — is this the one? — so the trailer sits here beside the TVs rather than
 * making you commit to playing something to find out what it is.
 *
 * The trailer plays inside this panel rather than in a window over it. Watching
 * a trailer is how you decide to watch the thing, so the moment you have
 * decided is exactly the moment the trailer is covering the TV list. Keeping
 * both on screen means the answer to "yes, that one" is right there.
 */
export default function WatchOnDevicePicker({ item, serverKey, onClose }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(null);
  const [playing, setPlaying] = useState(null);
  // A TV the server would not let this device use, and why, shown beside it.
  const [refused, setRefused] = useState(null);
  const [trailer, setTrailer] = useState(null);
  const [trailerState, setTrailerState] = useState('idle');
  const playerRef = useRef(null);

  const showTrailer = async () => {
    if (!item?.tmdbId) return;
    setTrailerState('loading');
    try {
      const data = await getTrailer(item.tmdbId, item.type || 'movie');
      const found = data.trailerUrl || data.url || data.key;
      if (!found) {
        setTrailerState('none');
        return;
      }
      const embed = found.startsWith('http')
        ? found.replace('www.youtube.com', 'www.youtube-nocookie.com').replace('watch?v=', 'embed/') + (found.includes('watch?v=') ? '?autoplay=1&rel=0' : '')
        : `https://www.youtube-nocookie.com/embed/${found}?autoplay=1&rel=0`;
      setTrailer(embed);
      setTrailerState('playing');
    } catch {
      setTrailerState('none');
    }
  };

  const goFullscreen = () => {
    const el = playerRef.current;
    if (!el) return;
    const request = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitEnterFullscreen;
    if (request) Promise.resolve(request.call(el)).catch(() => {});
  };

  useEffect(() => {
    setLoading(true);
    getTvDevices()
      .then((d) => setDevices(d.devices || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const sendTo = async (device) => {
    setSending(device.id);
    setError(null);
    setRefused(null);
    try {
      const result = await playOnTv({
        serverKey: item.serverKey || serverKey,
        ratingKey: item.ratingKey,
        controlUrl: device.controlUrl,
      });
      setPlaying({ device, result });
    } catch (err) {
      // Not approved by the owner: say so on that TV and keep the list, since
      // another TV in it may be approved.
      if (err.tvNotApproved) setRefused({ controlUrl: device.controlUrl, message: err.message });
      else setError(err.message);
    } finally {
      setSending(null);
    }
  };

  const stop = async () => {
    if (!playing) return;
    try {
      await controlTv(playing.device.controlUrl, 'stop');
      setPlaying(null);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-white/5">
          <h3 className="text-lg font-bold text-gray-50">{item?.title}</h3>
          <p className="text-xs text-gray-400 mt-1">
            {item?.year || ''}
            {item?.year && item?.type ? ' · ' : ''}
            {item?.type === 'show' ? 'TV' : item?.type === 'movie' ? 'Film' : ''}
          </p>
        </div>

        {item?.tmdbId && !playing && trailerState !== 'playing' && (
          <div className="px-5 pt-4">
            <button
              onClick={showTrailer}
              disabled={trailerState === 'loading' || trailerState === 'none'}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 border border-surface-700 text-sm font-semibold text-gray-100 hover:text-white transition-all disabled:opacity-50"
            >
              {trailerState === 'loading' ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="10" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" className="opacity-75" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              )}
              <span>{trailerState === 'none' ? 'No trailer found' : 'Watch trailer'}</span>
            </button>
          </div>
        )}

        {trailerState === 'playing' && trailer && !playing && (
          <div className="px-5 pt-4">
            <div ref={playerRef} className="relative w-full bg-black rounded-lg overflow-hidden" style={{ paddingBottom: '56.25%' }}>
              <iframe
                src={trailer}
                className="absolute inset-0 w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
                title="Trailer"
              />
            </div>
            <div className="flex items-center gap-3 mt-2">
              <button onClick={goFullscreen} className="text-xs font-semibold text-gray-400 hover:text-white transition-colors">
                Full screen
              </button>
              <button
                onClick={() => { setTrailerState('idle'); setTrailer(null); }}
                className="text-xs font-semibold text-gray-400 hover:text-white transition-colors"
              >
                Stop trailer
              </button>
            </div>
          </div>
        )}

        {!playing && (
          <p className="px-5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {trailerState === 'playing' ? 'Send the real thing to a TV' : 'Or send it to a TV'}
          </p>
        )}

        <div className="p-5 max-h-[60vh] overflow-y-auto">
          {playing ? (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                <div className="text-sm font-semibold text-green-300">
                  Playing on {playing.device.name}
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  {playing.result.relayed
                    ? 'Converting the soundtrack on the fly so your TV can play it. Leave the computer running this app awake.'
                    : 'Streaming the original file straight to the TV.'}
                </div>
              </div>
              <button
                onClick={stop}
                className="w-full p-3 rounded-lg bg-surface-800 hover:bg-surface-700 border border-surface-700 text-sm font-semibold text-gray-200 transition-all"
              >
                Stop
              </button>
            </div>
          ) : loading ? (
            <div className="text-gray-400 text-sm">Looking for TVs on your network…</div>
          ) : error ? (
            <div className="text-amber-300 text-sm">{error}</div>
          ) : devices.length === 0 ? (
            <div className="text-gray-400 text-sm">
              No TVs answered. Make sure the TV is switched on and on the same wifi, then reopen this.
            </div>
          ) : (
            <ul className="space-y-2">
              {devices.map((d) => (
                <li key={d.controlUrl}>
                  <button
                    onClick={() => sendTo(d)}
                    disabled={sending === d.id}
                    className="w-full text-left p-3 rounded-lg bg-surface-800 hover:bg-surface-700 border border-surface-700 transition-all disabled:opacity-50"
                  >
                    <div className="text-sm font-medium text-gray-100">📺 {d.name}</div>
                    {d.model && <div className="text-[11px] text-gray-400 mt-0.5">{d.model}</div>}
                    {sending === d.id && <div className="text-xs text-amber-400 mt-1">Starting…</div>}
                  </button>
                  {refused?.controlUrl === d.controlUrl && (
                    <div className="mt-1 px-1 text-xs text-amber-300">{refused.message}</div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {error && !loading && devices.length > 0 && (
            <div className="mt-3 text-amber-300 text-xs">{error}</div>
          )}
        </div>
      </div>
    </div>
  );
}
