// First, before anything reads the browser's storage.
import './lib/storage-migrate';
import React, { useCallback, useEffect, useState } from 'react';
import { installProfileHeader } from './lib/profile';
import { applyStoredSkin } from './components/SkinSwitcher';
import ReactDOM from 'react-dom/client';
import App from './App';
import SetupWizard from './components/SetupWizard';
import PinGate from './components/PinGate';
import OwnerClaim from './components/OwnerClaim';
import ErrorBoundary from './components/ErrorBoundary';
import NoticeHost from './components/NoticeHost';
import LookOnly from './components/LookOnly';
import { getAuthStatus, installPinWatcher, setCanChangeKnown, setDownloadsKnown } from './lib/setup';
import './index.css';

// Tag API calls with the current viewer before anything renders and fetches.
installProfileHeader();
// Paint the chosen look before first render so it never flashes the default.
applyStoredSkin();

/**
 * Decides what this device sees first: the PIN prompt, first-run setup, or the
 * app. Checked before the app mounts, so a locked or unconfigured install never
 * shows a page of empty rows and failed requests.
 */
function Root() {
  const [stage, setStage] = useState('loading');
  const [error, setError] = useState('');

  const decide = useCallback(async () => {
    try {
      // One quick local check; nothing here waits on plex.tv.
      const auth = await getAuthStatus();
      if (!auth.signedIn) return setStage('pin');
      setDownloadsKnown(auth.downloadsEnabled);
      // An older server does not say; assume it can, as it always could.
      setCanChangeKnown(auth.canChange !== false);
      if (auth.setupComplete) return setStage('app');
      // Setup is for the owner. Anyone else first proves it with the code
      // from the log, so a guest cannot set up someone else's install.
      setStage(auth.isOwner ? 'setup' : 'claim');
    } catch (err) {
      setError(err.message || 'Could not reach the Heldover server');
      setStage('error');
    }
  }, []);

  useEffect(() => {
    installPinWatcher(() => setStage('pin'));
    decide();
  }, [decide]);

  if (stage === 'pin') return <PinGate onUnlocked={decide} />;
  if (stage === 'setup') return <SetupWizard onDone={decide} />;
  if (stage === 'claim') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-900 px-4">
        <div className="w-full max-w-md space-y-4">
          <div className="text-center">
            <p className="text-4xl">🎬</p>
            <h1 className="text-2xl font-extrabold text-gray-100 mt-2">Set up Heldover</h1>
          </div>
          <OwnerClaim onClaimed={decide} />
        </div>
      </div>
    );
  }
  if (stage === 'app') {
    return (
      <>
        <App />
        <LookOnly />
      </>
    );
  }
  if (stage === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-900 text-center px-4">
        <div className="space-y-3">
          <p className="text-gray-200 font-semibold">{error}</p>
          <button onClick={decide} className="px-4 py-2 rounded-lg bg-surface-700 text-gray-100 text-sm">Try again</button>
        </div>
      </div>
    );
  }
  return <div className="min-h-screen bg-surface-900" />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
    <NoticeHost />
  </React.StrictMode>
);
