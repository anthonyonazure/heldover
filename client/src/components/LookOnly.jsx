import React, { useEffect, useState } from 'react';
import OwnerClaim from './OwnerClaim';
import { onChangeRefused, useCanChange } from '../lib/setup';

const DISMISSED_KEY = 'heldover.lookOnlyDismissed';

function wasDismissed() {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Shown on a device that can look but not change anything: no PIN is set and
 * this is not one of the owner's devices. A small marker says so up front, and
 * when a tap is refused it opens the way to unlock the device, so nobody is
 * left wondering why a thumbs-up did nothing.
 */
export default function LookOnly() {
  const canChange = useCanChange();
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [open, setOpen] = useState(false);

  // A refused change brings the explanation up, even after "Not now".
  useEffect(() => onChangeRefused(() => setOpen(true)), []);

  if (canChange) return null;

  const dismiss = () => {
    setOpen(false);
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Private browsing: the marker simply comes back on the next page.
    }
  };

  return (
    <>
      {!open && !dismissed && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-16 sm:bottom-4 left-4 z-[75] flex items-center gap-2 px-3 py-2 rounded-full bg-surface-800/95 border border-surface-600 text-xs font-semibold text-gray-200 shadow-lg backdrop-blur hover:border-accent"
        >
          <span aria-hidden="true">🔒</span>
          Look only · Unlock
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-black/70 px-4 pb-4" role="dialog" aria-modal="true" aria-label="Unlock this device">
          <div className="w-full max-w-md rounded-2xl bg-surface-900 border border-surface-700 p-5 space-y-4 shadow-2xl">
            <div>
              <h2 className="text-lg font-extrabold text-gray-100">This device can look, not change</h2>
              <p className="text-sm text-gray-400 mt-1">
                You can browse everything here. Rating, hiding, queueing, swiping, casting to the TV and downloading
                are switched off on this device until it is unlocked.
              </p>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-bold text-gray-200">For family and guests: a PIN</h3>
              <p className="text-sm text-gray-400">
                Ask whoever runs Heldover to set a PIN in Settings. Every device then asks for it once and can
                change things after that.
              </p>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-bold text-gray-200">For the owner: the settings code</h3>
              <p className="text-sm text-gray-400">
                The code makes this device an owner, able to change settings too.
              </p>
              <OwnerClaim compact onClaimed={() => window.location.reload()} />
            </div>

            <button onClick={dismiss} className="w-full py-2.5 rounded-lg bg-surface-700 text-gray-100 text-sm font-semibold">
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );
}
