import React, { useState, useRef } from 'react';
import { askForSomething } from '../lib/api';
import RatingBadge from './RatingBadge';

const EXAMPLES = [
  'something funny under two hours',
  'nothing scary, under 90 minutes',
  'highly rated sci-fi from the 90s',
  'a documentary, nothing sad',
];

/**
 * Ask in plain words instead of setting fourteen filters.
 *
 * The filter panel can already express everything this does. The point is that
 * expressing it requires knowing the panel exists, what each control means, and
 * which combination gets you there. A sentence requires none of that.
 */
export default function AskBox({ onPick }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Only the latest question's answer is shown. Tapping two examples in
  // quick succession could otherwise show the first answer under the second
  // question, whichever the server happened to finish last.
  const latest = useRef(0);

  const ask = async (text) => {
    const q = (text ?? question).trim();
    if (!q) return;
    const mine = ++latest.current;
    setQuestion(q);
    setLoading(true);
    setError('');
    try {
      const answer = await askForSomething(q);
      if (mine === latest.current) setResult(answer);
    } catch (err) {
      if (mine !== latest.current) return;
      setError(err.message);
      setResult(null);
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  };

  return (
    <section className="mb-6">
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="What are you in the mood for?"
          className="flex-1 min-w-0 px-4 py-3 bg-surface-800 border border-surface-600 rounded-xl text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-smooth"
        />
        <button
          onClick={() => ask()}
          disabled={loading || !question.trim()}
          className="px-5 py-3 rounded-xl bg-accent text-black text-sm font-bold hover:brightness-110 disabled:opacity-40 transition-smooth"
        >
          {loading ? '…' : 'Find'}
        </button>
      </div>

      {!result && !loading && (
        <div className="flex gap-1.5 flex-wrap mt-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => ask(ex)}
              className="px-2.5 py-1 rounded-full text-[11px] bg-surface-800 text-gray-400 hover:text-gray-200 hover:bg-surface-700 transition-smooth"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-sm text-amber-300">{error}</p>}

      {result && (
        <div className="mt-3">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            {/* Saying back what was understood is the difference between "no
                matches" and "I did not understand you" — from the outside those
                look identical, and one of them is worth rephrasing. */}
            <span className="text-[11px] text-gray-500">Looking for</span>
            {result.understood?.length ? (
              result.understood.map((u) => (
                <span key={u} className="px-2 py-0.5 rounded-full text-[11px] bg-surface-700 text-gray-200">
                  {u}
                </span>
              ))
            ) : (
              <span className="text-[11px] text-amber-300">
                anything — I could not pick anything specific out of that
              </span>
            )}
            {/* Heard but not used, said plainly rather than implied. */}
            {result.ignored?.map((u) => (
              <span key={u} className="px-2 py-0.5 rounded-full text-[11px] bg-amber-500/10 text-amber-300">
                {u}
              </span>
            ))}
            <span className="text-[11px] text-gray-500 ml-auto">
              {result.stillReading
                ? 'still reading your libraries'
                : `${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'}`}
            </span>
            <button
              onClick={() => { setResult(null); setQuestion(''); }}
              className="text-[11px] text-gray-500 hover:text-gray-300"
            >
              clear
            </button>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5 sm:gap-3">
            {result.items.map((item) => (
              <button
                key={`${item.serverKey}:${item.ratingKey}`}
                onClick={() => onPick && onPick(item)}
                className="group text-left rounded-xl overflow-hidden bg-surface-850 border border-white/5 hover:border-amber-400/40 hover:scale-[1.04] transition-all duration-300"
              >
                <div className="relative aspect-[2/3] bg-surface-700 overflow-hidden">
                  {item.thumb ? (
                    <img src={item.thumb} alt={item.title} loading="lazy" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-2xl opacity-40">🎬</div>
                  )}
                  {item.imdbRating != null && (
                    <div className="absolute bottom-1.5 left-1.5">
                      <RatingBadge value={item.imdbRating} type="imdb" size="sm" />
                    </div>
                  )}
                </div>
                <div className="p-2">
                  <h4 className="text-xs font-semibold text-gray-100 truncate">{item.title}</h4>
                  <span className="text-[10px] text-gray-500">{item.year || ''}</span>
                </div>
              </button>
            ))}
          </div>

          {result.items.length === 0 && !result.stillReading && (
            <p className="text-sm text-gray-500 py-6 text-center">
              Nothing matched that. Try asking for less at once.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
