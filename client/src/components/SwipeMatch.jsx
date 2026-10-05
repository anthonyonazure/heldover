import React, { useEffect, useState, useCallback } from 'react';
import { createSwipeSession, getSwipeSession, sendSwipeVote } from '../lib/api';

/**
 * Two phones, one deck, first mutual yes wins.
 *
 * The problem being solved is social, not technical: nobody wants to be the one
 * who picked the bad film. Swiping privately and letting the app announce the
 * overlap takes the authorship out of the decision.
 */
export default function SwipeMatch({ onClose, onPlay }) {
  const [code, setCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [deck, setDeck] = useState([]);
  const [index, setIndex] = useState(0);
  const [matches, setMatches] = useState([]);
  const [voters, setVoters] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Set when the other phone dealt a new round from this one.
  const [nextCode, setNextCode] = useState(null);

  const start = async () => {
    setLoading(true);
    setError('');
    try {
      // Naming the round this one follows lets the other phone see the new
      // code and follow it, instead of swiping a deck nobody else sees.
      const session = await createSwipeSession({ size: 40, previousCode: code || undefined });
      setCode(session.code);
      setDeck(session.deck || []);
      setIndex(0);
      setMatches([]);
      setVoters(0);
      setNextCode(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const join = async (raw) => {
    const wanted = (raw || joinCode).trim().toUpperCase();
    if (!wanted) return;
    setLoading(true);
    setError('');
    try {
      const session = await getSwipeSession(wanted);
      setCode(session.code);
      setDeck(session.deck || []);
      setMatches(session.matches || []);
      setVoters(session.voters || 0);
      setNextCode(session.nextCode || null);
      // Pick up where this person left off rather than restarting the deck.
      const votedKeys = new Set(Object.keys(session.myVotes || {}));
      const next = (session.deck || []).findIndex((c) => !votedKeys.has(c.cardKey));
      setIndex(next === -1 ? (session.deck || []).length : next);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const vote = useCallback(
    async (choice) => {
      const at = index;
      const card = deck[at];
      if (!card || !code) return;
      setIndex((i) => i + 1);
      setError('');
      // A vote that never arrives is a match that can never happen, with no
      // sign of it on either phone. One quiet retry covers a Wi-Fi blip; after
      // that the card comes back so it can be swiped again.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await sendSwipeVote({ code, cardKey: card.cardKey, vote: choice });
          setMatches(result.matches || []);
          setVoters(result.voters || 0);
          if (result.nextCode) setNextCode(result.nextCode);
          return;
        } catch {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
        }
      }
      setIndex((i) => (i === at + 1 ? at : i));
      setError('That swipe did not reach the server. Check the Wi-Fi and swipe it again.');
    },
    [deck, index, code]
  );

  // Poll while swiping so the other person's yes shows up without a refresh.
  useEffect(() => {
    if (!code) return undefined;
    const timer = setInterval(async () => {
      try {
        const session = await getSwipeSession(code);
        setMatches(session.matches || []);
        setVoters(session.voters || 0);
        setNextCode(session.nextCode || null);
      } catch { /* keep swiping */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [code]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (!code) return;
      if (e.key === 'ArrowRight' || e.key === 'y') vote('yes');
      if (e.key === 'ArrowLeft' || e.key === 'n') vote('no');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, vote, code]);

  const card = deck[index];
  const done = code && index >= deck.length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-900">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 glass">
        <div>
          <h2 className="text-lg font-extrabold text-gray-100">💘 Both of you</h2>
          <p className="text-xs text-gray-500">
            {code
              ? `Code ${code} · ${voters} ${voters === 1 ? 'person' : 'people'} swiping`
              : 'Swipe separately, watch what you both said yes to'}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-surface-700 transition-smooth"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
            {error}
          </div>
        )}

        {!code && (
          <div className="max-w-sm mx-auto mt-10 space-y-4">
            <button
              onClick={start}
              disabled={loading}
              className="w-full py-3 rounded-xl bg-accent text-black font-bold disabled:opacity-50"
            >
              {loading ? 'Dealing…' : 'Start a new round'}
            </button>

            <div className="flex items-center gap-2 text-xs text-gray-600">
              <div className="flex-1 h-px bg-surface-700" />
              or join theirs
              <div className="flex-1 h-px bg-surface-700" />
            </div>

            <div className="flex gap-2">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && join()}
                placeholder="CODE"
                maxLength={4}
                className="flex-1 min-w-0 px-4 py-3 bg-surface-800 border border-surface-600 rounded-xl text-center tracking-[0.4em] text-lg text-gray-100 placeholder-gray-600 focus:outline-none focus:border-accent"
              />
              <button
                onClick={() => join()}
                disabled={loading || joinCode.length < 4}
                className="px-5 py-3 rounded-xl bg-surface-700 text-gray-100 font-bold disabled:opacity-40"
              >
                Join
              </button>
            </div>

            <p className="text-xs text-gray-500 text-center leading-relaxed">
              One of you starts a round and reads out the code. The other joins it.
              Then you both swipe on the same films without seeing each other's answers.
            </p>
          </div>
        )}

        {code && nextCode && (
          <div className="mb-4 p-3 rounded-xl bg-accent/10 border border-accent/40 flex items-center justify-between gap-3">
            <p className="text-sm text-gray-200">A new round was dealt: code {nextCode}.</p>
            <button
              onClick={() => join(nextCode)}
              className="px-4 py-2 rounded-lg bg-accent text-black text-sm font-bold"
            >
              Join it
            </button>
          </div>
        )}

        {code && matches.length > 0 && (
          <div className="mb-4 p-3 rounded-xl bg-green-500/10 border border-green-500/30">
            <p className="text-sm font-bold text-green-300 mb-2">
              You both said yes to {matches.length === 1 ? 'this' : 'these'}
            </p>
            <div className="flex gap-2 overflow-x-auto">
              {matches.map((m) => (
                <button
                  key={m.cardKey}
                  onClick={() => onPlay && onPlay(m)}
                  className="flex-shrink-0 w-[110px] text-left rounded-lg overflow-hidden bg-surface-850 border border-green-500/30 hover:border-green-400"
                >
                  {m.thumb ? (
                    <img loading="lazy" decoding="async" src={m.thumb} alt={m.title} className="w-full aspect-[2/3] object-cover" />
                  ) : (
                    <div className="w-full aspect-[2/3] flex items-center justify-center text-2xl">🎬</div>
                  )}
                  <div className="p-1.5">
                    <p className="text-[11px] font-semibold text-gray-100 truncate">{m.title}</p>
                    <p className="text-[10px] text-green-400">Play on TV</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {card && (
          <div className="max-w-sm mx-auto">
            <div className="rounded-2xl overflow-hidden bg-surface-850 border border-white/5 shadow-2xl">
              {card.thumb ? (
                <img src={card.thumb} alt={card.title} className="w-full aspect-[2/3] object-cover" />
              ) : (
                <div className="w-full aspect-[2/3] flex items-center justify-center text-5xl opacity-40">🎬</div>
              )}
              <div className="p-3">
                <h3 className="text-base font-bold text-gray-100">{card.title}</h3>
                <p className="text-xs text-gray-500">
                  {card.year}
                  {card.imdbRating ? ` · ${card.imdbRating.toFixed(1)}` : ''}
                  {card.genres?.length ? ` · ${card.genres.slice(0, 2).join(', ')}` : ''}
                </p>
                {card.summary && (
                  <p className="text-xs text-gray-400 mt-2 line-clamp-3">{card.summary}</p>
                )}
              </div>
            </div>

            <div className="flex gap-3 mt-4">
              <button
                onClick={() => vote('no')}
                className="flex-1 py-4 rounded-xl bg-surface-800 border border-surface-600 text-gray-300 font-bold text-lg hover:bg-surface-700 transition-smooth"
              >
                Nope
              </button>
              <button
                onClick={() => vote('yes')}
                className="flex-1 py-4 rounded-xl bg-accent text-black font-bold text-lg hover:brightness-110 transition-smooth"
              >
                Yes
              </button>
            </div>

            <p className="text-center text-[11px] text-gray-600 mt-2">
              {deck.length - index} left · arrow keys work too
            </p>
          </div>
        )}

        {done && (
          <div className="max-w-sm mx-auto mt-10 text-center">
            <p className="text-gray-300 font-semibold mb-1">That is the whole deck.</p>
            <p className="text-sm text-gray-500 mb-4">
              {matches.length > 0
                ? 'Your matches are above.'
                : 'No agreement yet. Either they are still swiping, or you two need a new deck.'}
            </p>
            <button onClick={start} className="px-5 py-2.5 rounded-xl bg-surface-800 border border-surface-600 text-sm font-semibold text-gray-200">
              Deal another round
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
