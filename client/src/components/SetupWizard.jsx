import React, { useEffect, useState } from 'react';
import PlexLink from './PlexLink';
import { getSetupStatus, saveKeys, saveProfileNames, setAccessPin, completeSetup } from '../lib/setup';

const STEPS = ['Plex', 'Ratings', 'People', 'PIN'];

const inputClass =
  'w-full px-3 py-2.5 bg-surface-800 border border-surface-600 rounded-lg text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-accent';
const primary = 'px-5 py-2.5 rounded-xl bg-accent text-black font-bold disabled:opacity-40';
const secondary = 'px-5 py-2.5 rounded-xl bg-surface-800 border border-surface-600 text-gray-300 font-semibold';

/**
 * First run, on the web page itself, so it works the same from the desktop
 * app, Docker, or a clone of the code. Four short steps, each skippable where
 * the app can still work without it.
 */
export default function SetupWizard({ onDone }) {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState(null);
  const [tmdbKey, setTmdbKey] = useState('');
  const [names, setNames] = useState(['', '']);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => getSetupStatus().then(setStatus).catch((err) => setError(err.message));
  useEffect(() => { refresh(); }, []);

  const run = async (work) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveTmdb = () => run(async () => {
    if (tmdbKey.trim()) await saveKeys({ tmdbApiKey: tmdbKey });
    await refresh();
    setStep(2);
  });

  const savePeople = () => run(async () => {
    await saveProfileNames(names.map((n) => n.trim()).filter(Boolean));
    setStep(3);
  });

  const finish = (withPin) => run(async () => {
    if (withPin) await setAccessPin(pin);
    await completeSetup();
    onDone();
  });

  return (
    <div className="min-h-screen flex items-start sm:items-center justify-center bg-surface-900 px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <p className="text-4xl">🎬</p>
          <h1 className="text-2xl font-extrabold text-gray-100 mt-2">Set up Heldover</h1>
          <div className="flex justify-center gap-2 mt-4">
            {STEPS.map((label, i) => (
              <span
                key={label}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                  i === step ? 'bg-accent text-black' : i < step ? 'bg-surface-700 text-gray-300' : 'bg-surface-800 text-gray-600'
                }`}
              >
                {i + 1}. {label}
              </span>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-amber-300 text-center">{error}</p>}

        {step === 0 && (
          <section className="space-y-4">
            <p className="text-sm text-gray-400">
              Sign in so the app can see your libraries and the ones friends share with you. Your Plex sign-in
              stays on this computer and is never sent to the browser.
            </p>
            {status?.plexConnected ? (
              <div className="space-y-3">
                <p className="text-sm text-green-300">Signed in as {status.plexUser}.</p>
                <button className={primary} onClick={() => setStep(1)}>Next</button>
              </div>
            ) : (
              <PlexLink onConnected={() => refresh().then(() => setStep(1))} />
            )}
          </section>
        )}

        {step === 1 && (
          <section className="space-y-4">
            <p className="text-sm text-gray-400">
              Ratings, trailers, "where is it streaming" and recommendations come from TMDB. A key is free:
              make an account at{' '}
              <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                themoviedb.org/settings/api
              </a>{' '}
              and paste the "API Key" here.
            </p>
            {status?.tmdbConfigured ? (
              <p className="text-sm text-green-300">A TMDB key is already set. Paste a new one only to replace it.</p>
            ) : null}
            <input value={tmdbKey} onChange={(e) => setTmdbKey(e.target.value)} placeholder="TMDB API key" className={inputClass} />
            <div className="flex gap-2">
              <button className={primary} disabled={busy} onClick={saveTmdb}>{busy ? 'Checking…' : 'Next'}</button>
              {!status?.tmdbConfigured && (
                <button className={secondary} onClick={() => setStep(2)}>Skip for now</button>
              )}
            </div>
            {!status?.tmdbConfigured && (
              <p className="text-xs text-gray-500">Without it the app still lists your libraries, but most of what makes it useful is missing.</p>
            )}
          </section>
        )}

        {step === 2 && (
          <section className="space-y-4">
            <p className="text-sm text-gray-400">
              Who watches here? Each person gets their own thumbs, watchlist and recommendations.
            </p>
            {names.map((name, i) => (
              <input
                key={i}
                value={name}
                onChange={(e) => setNames((list) => list.map((n, j) => (j === i ? e.target.value : n)))}
                placeholder={i === 0 ? 'Your name' : 'Someone else (optional)'}
                className={inputClass}
              />
            ))}
            {names.length < 8 && (
              <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setNames((list) => [...list, ''])}>
                + Add another person
              </button>
            )}
            <div>
              <button className={primary} disabled={busy || !names[0].trim()} onClick={savePeople}>Next</button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="space-y-4">
            <p className="text-sm text-gray-400">
              Anyone on your Wi-Fi can open Heldover and look around. Only devices that have entered the PIN
              can change things: rate, queue, swipe, send to the TV. Set one if phones in your home should do
              that; each asks for it once. Without a PIN, only the owner's devices can. You can change this later in
              Settings.
            </p>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              maxLength={12}
              placeholder="6 to 12 digits"
              className={`${inputClass} text-center tracking-[0.3em]`}
            />
            <div className="flex gap-2">
              <button className={primary} disabled={busy || pin.length < 6} onClick={() => finish(true)}>Set PIN and finish</button>
              <button className={secondary} disabled={busy} onClick={() => finish(false)}>No PIN</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
