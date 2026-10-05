import React, { useState, useEffect, useRef } from 'react';
import { useDownloadsEnabled } from '../lib/setup';

function DownloadIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" />
    </svg>
  );
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function DownloadManagerInner() {
  const [showPanel, setShowPanel] = useState(false);
  const [history, setHistory] = useState([]);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  const loadHistory = () => {
    try {
      const data = JSON.parse(localStorage.getItem('plex-download-history') || '[]');
      setHistory(data);
    } catch {
      setHistory([]);
    }
  };

  useEffect(() => {
    loadHistory();
    const handler = () => loadHistory();
    window.addEventListener('download-history-updated', handler);
    return () => window.removeEventListener('download-history-updated', handler);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!showPanel) return;
    const handleClick = (e) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        buttonRef.current && !buttonRef.current.contains(e.target)
      ) {
        setShowPanel(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPanel]);

  const clearHistory = () => {
    localStorage.removeItem('plex-download-history');
    setHistory([]);
  };

  const recentCount = history.filter((h) => Date.now() - h.timestamp < 86400000).length;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setShowPanel((prev) => !prev)}
        className="group relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-amber-400 transition-smooth"
        title="Downloads"
      >
        <DownloadIcon className="w-5 h-5" />
        {recentCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center px-1 rounded-full text-[9px] font-bold bg-amber-500 text-black">
            {recentCount > 99 ? '99+' : recentCount}
          </span>
        )}
      </button>

      {showPanel && (
        <div
          ref={panelRef}
          className="absolute z-[60] right-0 mt-1 w-80 sm:w-96 bg-surface-800 border border-surface-600 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
          style={{ top: '100%' }}
        >
          <div className="px-3 py-2.5 border-b border-surface-700 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-300">Download History</span>
            <div className="flex items-center gap-2">
              {history.length > 0 && (
                <button
                  onClick={clearHistory}
                  className="text-[10px] text-gray-500 hover:text-red-400 transition-colors"
                >
                  Clear All
                </button>
              )}
              <button
                onClick={() => setShowPanel(false)}
                className="p-0.5 rounded hover:bg-surface-700 text-gray-500 hover:text-gray-300"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {history.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <DownloadIcon className="w-8 h-8 mx-auto text-gray-600 mb-2" />
              <p className="text-sm text-gray-500">No downloads yet</p>
              <p className="text-xs text-gray-600 mt-1">Downloads will appear here</p>
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {history.map((h, i) => (
                <div key={i} className="px-3 py-2.5 border-b border-surface-700/50 last:border-0 hover:bg-surface-700/30 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-200 font-medium truncate">
                        {h.title}{h.year ? ` (${h.year})` : ''}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {h.resolution && (
                          <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-amber-500/15 text-amber-400/80">
                            {h.resolution}
                          </span>
                        )}
                        {h.sizeFormatted && (
                          <span className="text-[10px] text-gray-500">{h.sizeFormatted}</span>
                        )}
                        <span className={`text-[10px] px-1 py-0.5 rounded ${
                          h.method === 'gopeed'
                            ? 'bg-purple-500/15 text-purple-400/80'
                            : 'bg-surface-700 text-gray-500'
                        }`}>
                          {h.method === 'gopeed' ? 'Gopeed' : 'Browser'}
                        </span>
                      </div>
                    </div>
                    <span className="shrink-0 text-[10px] text-gray-600 mt-0.5">
                      {formatTimestamp(h.timestamp)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Hidden entirely unless downloads are turned on in Settings. */
export default function DownloadManager(props) {
  const enabled = useDownloadsEnabled();
  return enabled ? <DownloadManagerInner {...props} /> : null;
}
