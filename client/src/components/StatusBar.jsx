import React, { useState, useEffect, useCallback } from 'react';
import { getStatus, checkStatus } from '../lib/api';

const BUILD_STAMP = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev';

export default function StatusBar() {
  const [updating, setUpdating] = useState(false);
  const [servers, setServers] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getStatus();
      setServers(Array.isArray(data) ? data : data.statuses || data.servers || []);
    } catch {
      // Status endpoint might not exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Throw away the offline copy of the app and start again from the server.
  const forceFresh = async () => {
    setUpdating(true);
    try {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      // Even if clearing fails, reloading is still the best next move.
    }
    window.location.replace(`/?fresh=${Date.now()}`);
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const data = await checkStatus();
      setServers(Array.isArray(data) ? data : data.statuses || data.servers || []);
    } catch {
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  };

  const offlineServers = servers.filter((s) => s.status === 'offline');

  if (loading && servers.length === 0) return null;
  if (servers.length === 0) return null;

  const getDotColor = (status) => {
    if (status === 'online') return 'bg-green-500';
    if (status === 'offline') return 'bg-red-500';
    return 'bg-gray-500';
  };

  const formatTime = (ts) => {
    if (!ts) return 'Unknown';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const timeSince = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <div className="lg:ml-[280px]">
      {/* Offline banner */}
      {offlineServers.length > 0 && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center gap-2 text-amber-400 text-sm">
          <span className="text-base">&#9888;</span>
          <span>
            {offlineServers.map((s) => s.name || s.serverName || 'Server').join(', ')}{' '}
            {offlineServers.length === 1 ? 'is' : 'are'} offline
            {offlineServers[0]?.offlineSince && (
              <span className="text-amber-500/70"> since {formatTime(offlineServers[0].offlineSince)}</span>
            )}
          </span>
        </div>
      )}

      {/* Status dots bar */}
      <div
        className="flex items-center gap-3 px-4 py-1.5 bg-surface-800/50 border-b border-surface-700/50 cursor-pointer select-none"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="flex items-center gap-2">
          {servers.map((server, i) => (
            <div key={server.id || server.name || i} className="flex items-center gap-1.5" title={`${server.name || 'Server'}: ${server.status || 'unknown'}`}>
              <span
                className={`w-2 h-2 rounded-full ${getDotColor(server.status)} ${
                  server.status === 'offline' ? 'animate-pulse' : ''
                }`}
              />
              <span className="text-xs text-gray-500 hidden sm:inline">{server.name || server.serverName || 'Server'}</span>
            </div>
          ))}
        </div>
        {/*
          Which build this device is actually running. The app keeps an offline
          copy of itself, and a phone can hold on to a stale one while the
          server serves the current one — which is indistinguishable from a fix
          that did not work. Tapping it throws that copy away and reloads, so
          there is a way out that does not involve clearing browser settings.
        */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            forceFresh();
          }}
          className="ml-auto text-[10px] font-mono text-gray-600 hover:text-accent transition-smooth"
          title={`Built ${BUILD_STAMP} — tap to discard the offline copy and reload`}
        >
          {updating ? 'refreshing…' : BUILD_STAMP}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleRefresh();
          }}
          className="p-1 rounded hover:bg-surface-700 text-gray-500 hover:text-gray-300 transition-smooth"
          title="Refresh status"
        >
          <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        <svg
          className={`w-3.5 h-3.5 text-gray-600 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expanded details */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          expanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="bg-surface-800/80 border-b border-surface-700/50 px-4 py-3 space-y-2">
          {servers.map((server, i) => (
            <div key={server.id || server.name || i} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${getDotColor(server.status)} ${server.status === 'offline' ? 'animate-pulse' : ''}`} />
                <span className="text-gray-300 font-medium">{server.name || server.serverName || 'Server'}</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500">
                {server.latency != null && <span>{server.latency}ms</span>}
                {server.lastChecked && <span>Checked {timeSince(server.lastChecked)}</span>}
                {server.status === 'offline' && server.offlineSince && (
                  <span className="text-red-400">Down since {formatTime(server.offlineSince)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
