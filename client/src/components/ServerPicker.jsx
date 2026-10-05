import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  getServers,
  getLibraries,
  getServerStatus,
  getServerBackoff,
  recheckServers,
} from '../lib/api';

/**
 * Human-friendly "time until" from seconds.
 */
function fmtUntil(secs) {
  if (secs == null) return null;
  if (secs <= 0) return 'now';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Collapse all signals into a single status for a server.
 * Precedence: revoked > backoff > offline > online.
 */
function deriveStatus({ status, backoff, libCount, reachable }) {
  if (backoff?.revoked) {
    return { key: 'revoked', label: 'Share revoked', tone: 'rose' };
  }
  if (backoff) {
    const until = fmtUntil(backoff.secondsUntilRetry);
    return { key: 'backoff', label: until ? `Backing off · retry ${until}` : 'Backing off', tone: 'amber' };
  }
  if (status?.online === true || libCount > 0) {
    return { key: 'online', label: 'Online', tone: 'emerald' };
  }
  if (reachable === false) {
    return { key: 'unreachable', label: 'No reachable connection', tone: 'rose' };
  }
  if (status?.online === false) {
    return { key: 'offline', label: 'Offline', tone: 'rose' };
  }
  return { key: 'unknown', label: 'Unknown', tone: 'gray' };
}

const TONE = {
  emerald: { dot: 'bg-emerald-400', text: 'text-emerald-400', ring: 'border-emerald-500/30' },
  amber: { dot: 'bg-amber-400', text: 'text-amber-400', ring: 'border-amber-500/30' },
  rose: { dot: 'bg-rose-500', text: 'text-rose-400', ring: 'border-rose-500/30' },
  gray: { dot: 'bg-gray-500', text: 'text-gray-400', ring: 'border-surface-600' },
};

export default function ServerPicker({ selectedLibrary, onSelect, onClose }) {
  const [servers, setServers] = useState([]);
  const [libraries, setLibraries] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [backedOff, setBackedOff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Each answer is used as it arrives. With all-or-nothing loading, one
      // slow or failed lookup (listing libraries reaches out to other people's
      // servers) blanked the whole panel even when the rest had answered.
      const [srv, libs, st, bo] = await Promise.allSettled([
        getServers(),
        getLibraries(),
        getServerStatus(),
        getServerBackoff(),
      ]);
      if (srv.status === 'fulfilled') setServers(srv.value.servers || []);
      if (libs.status === 'fulfilled') {
        setLibraries(libs.value.libraries || []);
        setWarnings(libs.value.warnings || []);
      }
      if (st.status === 'fulfilled') setStatuses(st.value.statuses || []);
      if (bo.status === 'fulfilled') setBackedOff(bo.value.backedOff || []);
      const failed = [srv, libs].find((r) => r.status === 'rejected');
      if (failed) setError(failed.reason?.message || 'Could not load everything');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const handleRecheck = useCallback(async () => {
    setRechecking(true);
    try {
      await recheckServers();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRechecking(false);
    }
  }, [load]);

  // Merge every signal into one row per server, keyed by clientIdentifier.
  const rows = useMemo(() => {
    const statusByKey = new Map((statuses || []).map((s) => [s.serverKey, s]));
    const backoffByKey = new Map((backedOff || []).map((b) => [b.serverKey, b]));
    const warnByKey = new Map((warnings || []).map((w) => [w.serverKey, w]));
    const libsByKey = new Map();
    for (const lib of libraries) {
      if (!libsByKey.has(lib.serverKey)) libsByKey.set(lib.serverKey, []);
      libsByKey.get(lib.serverKey).push(lib);
    }

    const list = servers.map((srv) => {
      const key = srv.clientIdentifier;
      const libs = libsByKey.get(key) || [];
      const backoff = backoffByKey.get(key) || null;
      const status = statusByKey.get(key) || null;
      const warn = warnByKey.get(key) || null;
      const derived = deriveStatus({
        status,
        backoff,
        libCount: libs.length,
        reachable: srv.reachable,
      });
      return {
        key,
        name: srv.sourceTitle ? `${srv.sourceTitle} / ${srv.name}` : srv.name,
        owned: srv.owned,
        libs,
        derived,
        lastError: backoff?.lastError || warn?.error || null,
        failures: backoff?.failures || null,
        lastCheckedAt: status?.lastCheckedAt || null,
        lastOnlineAt: status?.lastOnlineAt || null,
      };
    });

    // Online (with libraries) first, owned before shared, then by name.
    const order = { online: 0, unknown: 1, backoff: 2, offline: 3, unreachable: 3, revoked: 4 };
    return list.sort((a, b) => {
      const oa = order[a.derived.key] ?? 5;
      const ob = order[b.derived.key] ?? 5;
      if (oa !== ob) return oa - ob;
      if (a.owned !== b.owned) return a.owned ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [servers, libraries, warnings, statuses, backedOff]);

  const onlineCount = rows.filter((r) => r.derived.key === 'online').length;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      <div
        className="relative w-full sm:max-w-2xl max-h-[90vh] overflow-hidden bg-surface-800 rounded-t-2xl sm:rounded-2xl border border-surface-700 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-700 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-gray-100 flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
              Servers
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {loading ? 'Loading…' : `${onlineCount} of ${rows.length} online`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRecheck}
              disabled={rechecking || loading}
              className="px-3 py-2 rounded-lg bg-surface-700 hover:bg-surface-600 text-sm text-gray-200 disabled:opacity-50 transition-smooth flex items-center gap-1.5"
              title="Re-check all servers now"
            >
              <svg className={`w-4 h-4 ${rechecking ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="hidden sm:inline">{rechecking ? 'Checking…' : 'Re-check'}</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-white transition-smooth"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && !loading && (
            <div className="text-center py-8">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="text-center py-12 text-sm text-gray-500">
              No servers found. Check your PLEX_TOKEN.
            </div>
          )}

          {!loading &&
            rows.map((row) => {
              const tone = TONE[row.derived.tone] || TONE.gray;
              return (
                <div key={row.key} className={`rounded-xl border ${tone.ring} bg-surface-900/40 p-3`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${tone.dot} shrink-0`} />
                        <span className="font-semibold text-gray-100 truncate">{row.name}</span>
                        {row.owned && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 shrink-0">
                            OWNED
                          </span>
                        )}
                      </div>
                      <div className={`text-xs mt-0.5 ${tone.text}`}>
                        {row.derived.label}
                        {row.failures ? ` · ${row.failures} fail${row.failures > 1 ? 's' : ''}` : ''}
                      </div>
                      {row.lastError && row.derived.key !== 'online' && (
                        <div className="text-[11px] text-gray-500 mt-0.5 truncate" title={row.lastError}>
                          {row.lastError}
                        </div>
                      )}
                      {row.lastCheckedAt && (
                        <div className="text-[11px] text-gray-600 mt-0.5">
                          Checked {fmtTime(row.lastCheckedAt)}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Libraries */}
                  {row.libs.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {row.libs.map((lib) => {
                        const value = `${lib.serverKey}:${lib.key}`;
                        const active = value === selectedLibrary;
                        return (
                          <button
                            key={value}
                            onClick={() => onSelect(value)}
                            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-smooth flex items-center gap-1.5 ${
                              active
                                ? 'bg-amber-400 text-black'
                                : 'bg-surface-700 text-gray-200 hover:bg-surface-600'
                            }`}
                            title={`${lib.type === 'show' ? 'TV' : 'Movies'} · ${lib.title}`}
                          >
                            <span>{lib.type === 'show' ? '📺' : '🎬'}</span>
                            {lib.title}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    row.derived.key !== 'online' && (
                      <div className="text-[11px] text-gray-600 mt-2">No libraries available right now.</div>
                    )
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
