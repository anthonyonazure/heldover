import React, { useEffect, useRef, useState } from 'react';
import { startPlexLink, checkPlexLink, pastePlexToken } from '../lib/setup';

/**
 * Sign in to Plex the way every Plex app does: show a short code, the person
 * enters it at plex.tv/link on any device, and this app is handed its own
 * token. Nobody has to find a token in a hidden settings page.
 */
export default function PlexLink({ onConnected }) {
  const [code, setCode] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [token, setToken] = useState('');
  const timer = useRef(null);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  const begin = async () => {
    stop();
    setError('');
    setLoading(true);
    try {
      const pin = await startPlexLink();
      setCode(pin);
      // plex.tv is asked every few seconds whether the code has been entered.
      timer.current = setInterval(async () => {
        try {
          const result = await checkPlexLink(pin.id);
          if (result.connected) {
            stop();
            onConnected();
          }
        } catch (err) {
          // A hiccup at plex.tv is not the end of the code: keep waiting.
          // Only an expired code (410) stops the wait.
          if (err.status !== 410) return;
          stop();
          setCode(null);
          setError(err.message);
        }
      }, 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const paste = async () => {
    setError('');
    setLoading(true);
    try {
      await pastePlexToken(token);
      stop();
      onConnected();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      {!code ? (
        <button
          onClick={begin}
          disabled={loading}
          className="w-full py-3 rounded-xl bg-accent text-black font-bold disabled:opacity-50"
        >
          {loading ? 'Asking Plex…' : 'Sign in with Plex'}
        </button>
      ) : (
        <div className="p-4 rounded-xl bg-surface-800 border border-surface-600 text-center space-y-2">
          <p className="text-sm text-gray-300">
            On any phone or computer, open{' '}
            <a href="https://plex.tv/link" target="_blank" rel="noreferrer" className="text-accent font-semibold hover:underline">
              plex.tv/link
            </a>{' '}
            and enter:
          </p>
          <p className="text-4xl font-extrabold tracking-[0.3em] text-gray-100 select-all">{code.code}</p>
          <p className="text-xs text-gray-500">Waiting for you to enter it… this page will move on by itself.</p>
          <button onClick={begin} className="text-xs text-gray-500 hover:text-gray-300 underline">
            Get a new code
          </button>
        </div>
      )}

      {error && <p className="text-sm text-amber-300">{error}</p>}

      <button onClick={() => setShowPaste((v) => !v)} className="text-xs text-gray-500 hover:text-gray-300">
        {showPaste ? 'Hide' : 'I already have a Plex token'}
      </button>
      {showPaste && (
        <div className="flex gap-2">
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Plex token"
            type="password"
            className="flex-1 min-w-0 px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-gray-100 focus:outline-none focus:border-accent"
          />
          <button
            onClick={paste}
            disabled={loading || !token.trim()}
            className="px-4 py-2 rounded-lg bg-surface-700 text-gray-100 text-sm font-semibold disabled:opacity-40"
          >
            Use token
          </button>
        </div>
      )}
    </div>
  );
}
