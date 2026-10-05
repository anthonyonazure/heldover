import React, { useState, useEffect } from 'react';
import Credits from './Credits';
import PlexLink from './PlexLink';
import OwnerClaim from './OwnerClaim';
import { getSetupStatus, saveKeys, setAccessPin, setDownloads, setDownloadsKnown, setLanAccess, signOutOthers, waitForRestart } from '../lib/setup';
import { reportProblem } from '../lib/notice';
import { getTvApprovals, approveTv, removeTv } from '../lib/setup';

const inputClass =
  'w-full px-3 py-2 bg-surface-700 border border-surface-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-accent transition-smooth';
const smallButton = 'shrink-0 whitespace-nowrap px-3 py-2 rounded-lg bg-surface-700 text-gray-100 text-sm font-semibold disabled:opacity-40 hover:bg-surface-600';

/**
 * Everything the setup screen asked, changeable later. Keys are only ever sent
 * to the server and never shown back: the page knows whether a key is set, not
 * what it is. (The old version kept the Plex token in the browser's storage.)
 */
export default function SettingsModal({ open, onClose }) {
  const [status, setStatus] = useState(null);
  const [keys, setKeys] = useState({ tmdbApiKey: '', omdbApiKey: '', mdblistApiKey: '', fanartApiKey: '' });
  const [relinking, setRelinking] = useState(false);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsOwner, setNeedsOwner] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const refresh = () =>
    getSetupStatus()
      .then((s) => {
        setNeedsOwner(false);
        setStatus(s);
        setDownloadsKnown(s.downloadsEnabled);
      })
      .catch((err) => {
        // Settings belong to the owner; other devices are asked for the code.
        if (err.status === 403) setNeedsOwner(true);
        else setError(err.message);
      });

  useEffect(() => {
    if (!open) return;
    setMessage('');
    setError('');
    setRelinking(false);
    setPin('');
    setKeys({ tmdbApiKey: '', omdbApiKey: '', mdblistApiKey: '', fanartApiKey: '' });
    // Drop what an older version of the app left in this browser.
    try {
      ['plexToken', 'tmdbKey', 'omdbKey'].forEach((k) => localStorage.removeItem(k));
    } catch { /* storage unavailable */ }
    refresh();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleEsc = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  const run = async (work, done) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await refresh();
      if (done) setMessage(done);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // The server can only change the address it listens on by restarting, so
  // this does not go through run(): its refresh would land while the server
  // is away and report a failure that is not one. Wait for it, then reload.
  const changeLanAccess = async (enabled) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await setLanAccess(enabled);
      if (!result.restartRequired) {
        await refresh();
        return;
      }
      setStatus((s) => ({ ...s, lanAccess: result.lanAccess, lanUrls: [] }));
      setRestarting(true);
      // The page reloads once the app is back; come back to this screen, so
      // the address for phones is right there instead of a closed dialog.
      try {
        sessionStorage.setItem('heldover.reopenSettings', '1');
      } catch { /* storage unavailable: Settings just has to be opened again */ }
      await waitForRestart();
      window.location.reload();
    } catch (err) {
      reportProblem(`Could not change that setting: ${err.message}`, err);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const keyField = (name, label, isSet, hint) => (
    <div>
      <label className="block text-sm font-medium text-gray-300 mb-1">
        {label} {isSet && <span className="text-xs text-green-400 font-normal">· set</span>}
      </label>
      <input
        type="password"
        value={keys[name]}
        onChange={(e) => setKeys((k) => ({ ...k, [name]: e.target.value }))}
        placeholder={isSet ? 'Leave empty to keep the current key' : 'Not set'}
        className={inputClass}
      />
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );

  const changedKeys = Object.fromEntries(Object.entries(keys).filter(([, v]) => v.trim()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto bg-surface-800 rounded-2xl border border-surface-700 shadow-2xl"
      >
        <div className="flex items-center justify-between p-5 border-b border-surface-700">
          <h2 className="text-lg font-bold text-accent">Settings</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-700 transition-smooth">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {needsOwner ? (
          <div className="p-5 space-y-3">
            <h3 className="text-sm font-bold text-gray-200">Only the owner can change settings</h3>
            <OwnerClaim compact onClaimed={refresh} />
          </div>
        ) : (
        <div className="p-5 space-y-6">
          {error && <p className="text-sm text-amber-300">{error}</p>}
          {message && <p className="text-sm text-green-300">{message}</p>}

          <section className="space-y-2">
            <h3 className="text-sm font-bold text-gray-200">Plex account</h3>
            <p className="text-sm text-gray-400">
              {status?.plexConnected ? `Signed in as ${status.plexUser}.` : 'Not signed in, or the sign-in has expired.'}
            </p>
            {relinking || !status?.plexConnected ? (
              <PlexLink onConnected={() => { setRelinking(false); refresh(); setMessage('Signed in. Libraries will refresh shortly.'); }} />
            ) : (
              <button className={smallButton} onClick={() => setRelinking(true)}>Sign in again</button>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-bold text-gray-200">Rating sources</h3>
            {keyField('tmdbApiKey', 'TMDB API key', status?.tmdbConfigured, 'Free at themoviedb.org/settings/api. Needed for ratings, trailers and streaming info.')}
            {keyField('omdbApiKey', 'OMDb API key (optional)', status?.omdbConfigured, 'Adds IMDb and Rotten Tomatoes scores. omdbapi.com')}
            {keyField('mdblistApiKey', 'MDBList API key (optional)', status?.mdblistConfigured, 'Adds Letterboxd and Trakt scores. mdblist.com')}
            {keyField('fanartApiKey', 'Fanart.tv API key (optional)', status?.fanartConfigured, 'Adds backdrops and logos. fanart.tv')}
            <button
              className={smallButton}
              disabled={busy || Object.keys(changedKeys).length === 0}
              onClick={() => run(() => saveKeys(changedKeys), 'Keys saved.').then(() => setKeys({ tmdbApiKey: '', omdbApiKey: '', mdblistApiKey: '', fanartApiKey: '' }))}
            >
              Save keys
            </button>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-bold text-gray-200">Access PIN</h3>
            <p className="text-sm text-gray-400">
              {status?.pinEnabled
                ? 'On. Each device asks for it once, and can then rate, queue, swipe and cast. Setting a new PIN signs every other device out.'
                : status?.desktop && !status?.lanAccess
                  ? 'Off. Other devices cannot connect at the moment (see "Other devices" below), so there is nothing for a PIN to protect.'
                  : 'Off. Anyone on your network can open Heldover and look around, but only your own devices can change anything. Set a PIN to let phones in your home rate, queue, swipe and cast.'}
            </p>
            <div className="flex gap-2">
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                maxLength={12}
                placeholder={status?.pinEnabled ? 'New PIN' : '6 to 12 digits'}
                className={inputClass}
              />
              <button className={smallButton} disabled={busy || pin.length < 6} onClick={() => run(() => setAccessPin(pin), 'PIN saved.').then(() => setPin(''))}>
                {status?.pinEnabled ? 'Change' : 'Turn on'}
              </button>
            </div>
            {status?.pinEnabled && (
              <button className="text-xs text-gray-500 hover:text-gray-300" disabled={busy} onClick={() => run(() => setAccessPin(null), 'PIN turned off.')}>
                Turn the PIN off
              </button>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-bold text-gray-200">Downloads</h3>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(status?.downloadsEnabled)}
                disabled={busy || !status}
                onChange={(e) => run(() => setDownloads(e.target.checked))}
                className="mt-1 accent-amber-500"
              />
              <span className="text-sm text-gray-400">
                Show download buttons. Files are copied from the server they live on. On a server someone
                shared with you, downloads only work if its owner has switched on Allow Downloads for you in Plex.
              </span>
            </label>
          </section>

          {(status?.desktop || status?.ownerCode) && (
            <section className="space-y-2">
              <h3 className="text-sm font-bold text-gray-200">Other devices</h3>
              {status.desktop && (
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(status.lanAccess)}
                    disabled={busy || restarting || !status.isLocal}
                    onChange={(e) => changeLanAccess(e.target.checked)}
                    className="mt-1 accent-amber-500"
                  />
                  <span className="text-sm text-gray-400">
                    Let phones and other devices on my Wi-Fi connect. While this is off, Heldover only opens on
                    this computer.
                    {!status.isLocal && ' This can only be changed on the computer Heldover runs on.'}
                  </span>
                </label>
              )}
              {restarting && <p className="text-sm text-gray-400">Restarting Heldover, one moment…</p>}
              {status.lanUrls?.length > 0 && (
                <div className="text-sm text-gray-400">
                  <p>On a phone or another computer on your Wi-Fi, open:</p>
                  <ul className="mt-1 space-y-0.5">
                    {status.lanUrls.map((url) => (
                      <li key={url} className="font-mono text-gray-200 break-all select-all">{url}</li>
                    ))}
                  </ul>
                </div>
              )}
              {status.ownerCode && (
                <p className="text-sm text-gray-400">
                  Settings code:{' '}
                  <span className="font-mono font-semibold tracking-widest text-gray-100 select-all">{status.ownerCode}</span>
                  <br />
                  Enter this code on a phone or another computer to manage Heldover from it.
                </p>
              )}
            </section>
          )}

          <TvApprovals />

          <section className="space-y-2">
            <h3 className="text-sm font-bold text-gray-200">Devices</h3>
            <p className="text-sm text-gray-400">
              Signs out every other phone and browser, including other owners. They will need the PIN or settings code again.
            </p>
            <button className={smallButton} disabled={busy} onClick={() => run(() => signOutOthers(), 'Other devices signed out.')}>
              Sign out other devices
            </button>
          </section>
        </div>
        )}

        {/* Outside the owner-only part on purpose: guests must see it too. */}
        <Credits />
      </div>
    </div>
  );
}

/**
 * The TVs that phones and other devices may cast to. Anything on the network
 * can answer as a TV, so a device that only has the PIN is limited to the TVs
 * the owner has approved here. The owner's own casts approve a TV as they go.
 * Looking for TVs takes a few seconds, so this block loads on its own and the
 * rest of Settings does not wait for it.
 */
function TvApprovals() {
  const [approved, setApproved] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [looking, setLooking] = useState(true);
  const [working, setWorking] = useState(false);

  const look = async () => {
    setLooking(true);
    try {
      const tvs = await getTvApprovals();
      setApproved(tvs.approved || []);
      setDiscovered(tvs.discovered || []);
    } catch (err) {
      reportProblem(`Could not look for TVs: ${err.message}`, err);
    } finally {
      setLooking(false);
    }
  };

  useEffect(() => {
    look();
  }, []);

  const change = async (work) => {
    setWorking(true);
    try {
      const result = await work();
      setApproved(result.approved || []);
    } catch (err) {
      reportProblem(err.message, err);
    } finally {
      setWorking(false);
    }
  };

  const isApproved = (tv) => approved.some((a) => a.id === tv.id && a.host === tv.host);
  const waiting = discovered.filter((tv) => !isApproved(tv));

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-bold text-gray-200">TVs</h3>
      <p className="text-sm text-gray-400">
        Phones and other devices can only send films to TVs approved here. A TV you cast to from this
        computer is approved automatically.
      </p>
      {approved.length > 0 && (
        <ul className="space-y-2">
          {approved.map((tv) => (
            <li key={`${tv.id} ${tv.host}`} className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-sm text-gray-200">
                <span className="break-words">{tv.name}</span>
                <span className="block text-xs text-green-400">Approved · {tv.host}</span>
              </span>
              <button className={smallButton} disabled={working} onClick={() => change(() => removeTv(tv.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {waiting.length > 0 && (
        <ul className="space-y-2">
          {waiting.map((tv) => (
            <li key={`${tv.id} ${tv.host}`} className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-sm text-gray-200">
                <span className="break-words">{tv.name}</span>
                <span className="block text-xs text-gray-500">Not approved · {tv.host}</span>
              </span>
              <button className={smallButton} disabled={working} onClick={() => change(() => approveTv(tv.id))}>
                Approve
              </button>
            </li>
          ))}
        </ul>
      )}
      {looking ? (
        <p className="text-sm text-gray-400">Looking for TVs on your network…</p>
      ) : (
        <>
          {approved.length === 0 && waiting.length === 0 && (
            <p className="text-sm text-gray-400">No TVs answered. Make sure the TV is switched on, then look again.</p>
          )}
          <button className="text-xs text-gray-500 hover:text-gray-300" disabled={working} onClick={look}>
            Look again
          </button>
        </>
      )}
    </section>
  );
}
