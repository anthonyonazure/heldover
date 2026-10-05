import React, { useState, useRef, useEffect } from 'react';
import { useDownloadsEnabled } from '../lib/setup';
import { getDownloadUrl, sendToGopeed } from '../lib/api';

function DownloadIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" />
    </svg>
  );
}

function GopeedIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
}

function SpinnerIcon({ className }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="10" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" className="opacity-75" />
    </svg>
  );
}

function DownloadButtonInner({ item, serverKey, size = 'sm', onDownloadStart }) {
  const [loading, setLoading] = useState(false);
  const [downloads, setDownloads] = useState(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [gopeedSending, setGopeedSending] = useState(null);
  const [toast, setToast] = useState(null);
  const dropdownRef = useRef(null);
  const buttonRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    const handleClick = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        buttonRef.current && !buttonRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDropdown]);

  // Auto-hide toast
  useEffect(() => {
    if (!toast) return;
    // A reason takes longer to read than "Downloading file.mkv".
    const t = setTimeout(() => setToast(null), toast.type === 'error' ? 7000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const ratingKey = item?.ratingKey || item?.key;

  const handleClick = async (e) => {
    e.stopPropagation();
    if (!ratingKey || !serverKey) return;

    if (downloads) {
      setShowDropdown((prev) => !prev);
      return;
    }

    setLoading(true);
    try {
      const data = await getDownloadUrl(serverKey, ratingKey);
      setDownloads(data.downloads || []);
      setShowDropdown(true);
    } catch (err) {
      console.error('Failed to get download info:', err);
      setToast({ type: 'error', message: err.message || 'Failed to get download info' });
    } finally {
      setLoading(false);
    }
  };

  const handleDirectDownload = (dl, e) => {
    e.stopPropagation();
    // Save to download history in localStorage
    saveToHistory(dl);
    // Open in new tab for browser download
    window.open(dl.url, '_blank');
    setToast({ type: 'success', message: `Downloading ${dl.filename}` });
    if (onDownloadStart) onDownloadStart(dl);
    setShowDropdown(false);
  };

  const handleGopeed = async (dl, e) => {
    e.stopPropagation();
    setGopeedSending(dl.url);
    try {
      await sendToGopeed(dl.url, dl.filename);
      saveToHistory(dl, 'gopeed');
      setToast({ type: 'success', message: `Sent to Gopeed: ${dl.filename}` });
      if (onDownloadStart) onDownloadStart(dl);
      setShowDropdown(false);
    } catch (err) {
      console.error('Gopeed error:', err);
      setToast({ type: 'error', message: 'Gopeed unavailable. Is it running?' });
    } finally {
      setGopeedSending(null);
    }
  };

  const saveToHistory = (dl, method = 'browser') => {
    try {
      const history = JSON.parse(localStorage.getItem('plex-download-history') || '[]');
      history.unshift({
        title: item.title,
        year: item.year,
        filename: dl.filename,
        resolution: dl.resolution,
        size: dl.size,
        sizeFormatted: dl.sizeFormatted,
        method,
        timestamp: Date.now(),
      });
      // Keep last 50
      localStorage.setItem('plex-download-history', JSON.stringify(history.slice(0, 50)));
      // Dispatch event so DownloadManager can pick it up
      window.dispatchEvent(new CustomEvent('download-history-updated'));
    } catch {}
  };

  if (!ratingKey || !serverKey) return null;

  const sizeClasses = size === 'md'
    ? 'p-2 rounded-lg'
    : 'p-1 rounded';
  const iconSize = size === 'md' ? 'w-5 h-5' : 'w-4 h-4';

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleClick}
        disabled={loading}
        className={`${sizeClasses} transition-all duration-200 text-gray-400 hover:text-amber-400 hover:bg-black/30 disabled:opacity-50`}
        title="Download"
      >
        {loading ? <SpinnerIcon className={iconSize} /> : <DownloadIcon className={iconSize} />}
      </button>

      {/* Dropdown */}
      {showDropdown && downloads && (
        <div
          ref={dropdownRef}
          onClick={(e) => e.stopPropagation()}
          className="absolute z-[60] right-0 mt-1 w-72 sm:w-80 bg-surface-800 border border-surface-600 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
          style={{ top: '100%' }}
        >
          <div className="px-3 py-2 border-b border-surface-700 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-300">Download Options</span>
            <button
              onClick={(e) => { e.stopPropagation(); setShowDropdown(false); }}
              className="p-0.5 rounded hover:bg-surface-700 text-gray-500 hover:text-gray-300"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {downloads.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-gray-500">
              No downloadable files found
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {downloads.map((dl, i) => (
                <div key={i} className="px-3 py-2.5 border-b border-surface-700/50 last:border-0 hover:bg-surface-700/50 transition-colors">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {dl.resolution && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                          {dl.resolution}
                        </span>
                      )}
                      <span className="text-xs text-gray-400 truncate">
                        {dl.videoCodec || ''}{dl.videoCodec && dl.audioCodec ? ' / ' : ''}{dl.audioCodec || ''}
                        {dl.audioChannels ? ` ${dl.audioChannels}ch` : ''}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-gray-500">{dl.sizeFormatted}</span>
                  </div>

                  <p className="text-[10px] text-gray-600 truncate mb-2" title={dl.filename}>
                    {dl.filename}
                  </p>

                  <div className="flex gap-1.5">
                    <button
                      onClick={(e) => handleDirectDownload(dl, e)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors"
                    >
                      <DownloadIcon className="w-3.5 h-3.5" />
                      Download
                    </button>
                    <button
                      onClick={(e) => handleGopeed(dl, e)}
                      disabled={gopeedSending === dl.url}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-50"
                    >
                      {gopeedSending === dl.url ? (
                        <SpinnerIcon className="w-3.5 h-3.5" />
                      ) : (
                        <GopeedIcon className="w-3.5 h-3.5" />
                      )}
                      Gopeed
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-[70] max-w-[min(92vw,24rem)] px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium transition-all duration-300 ${
            toast.type === 'success'
              ? 'bg-green-500/20 border border-green-500/30 text-green-400'
              : 'bg-red-500/20 border border-red-500/30 text-red-400'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

/** Hidden entirely unless downloads are turned on in Settings. */
export default function DownloadButton(props) {
  const enabled = useDownloadsEnabled();
  return enabled ? <DownloadButtonInner {...props} /> : null;
}
