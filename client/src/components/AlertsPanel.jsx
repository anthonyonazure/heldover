import React, { useState, useEffect, useRef } from 'react';
import { getUnseenAlerts, markAlertAsSeen, markAllSubscriptionAlertsSeen } from '../lib/api';
import { reportProblem } from '../lib/notice';

function formatEpisode(season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return `S${s}E${e}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function AlertsPanel({ onClose }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef(null);

  useEffect(() => {
    fetchAlerts();
  }, []);

  useEffect(() => {
    const handleClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const fetchAlerts = async () => {
    try {
      const data = await getUnseenAlerts();
      setAlerts(data.alerts || []);
    } catch (err) {
      reportProblem("Couldn't load new-episode alerts.", err);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkSeen = async (alertId) => {
    try {
      await markAlertAsSeen(alertId);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      reportProblem("Couldn't clear that alert. Try again.", err);
    }
  };

  const handleMarkAllSeen = async (subscriptionId) => {
    try {
      await markAllSubscriptionAlertsSeen(subscriptionId);
      setAlerts((prev) => prev.filter((a) => a.subscription_id !== subscriptionId));
    } catch (err) {
      reportProblem("Couldn't clear those alerts. Try again.", err);
    }
  };

  const handleMarkAllGlobalSeen = async () => {
    // Get unique subscription IDs
    const subIds = [...new Set(alerts.map((a) => a.subscription_id))];
    try {
      await Promise.all(subIds.map((id) => markAllSubscriptionAlertsSeen(id)));
      setAlerts([]);
    } catch (err) {
      reportProblem("Couldn't clear those alerts. Try again.", err);
    }
  };

  // Group alerts by show
  const grouped = {};
  for (const alert of alerts) {
    const key = alert.subscription_id;
    if (!grouped[key]) {
      grouped[key] = {
        showTitle: alert.show_title,
        showThumb: alert.show_thumb,
        subscriptionId: alert.subscription_id,
        alerts: [],
      };
    }
    grouped[key].alerts.push(alert);
  }

  const groups = Object.values(grouped);

  return (
    <div
      ref={panelRef}
      className="absolute top-full right-0 mt-2 w-80 sm:w-96 max-h-[70vh] overflow-y-auto bg-surface-800 border border-surface-700 rounded-xl shadow-2xl z-50"
    >
      {/* Header */}
      <div className="sticky top-0 bg-surface-800 border-b border-surface-700 px-4 py-3 flex items-center justify-between z-10">
        <h3 className="text-sm font-bold text-gray-200">New Episodes</h3>
        {alerts.length > 0 && (
          <button
            onClick={handleMarkAllGlobalSeen}
            className="text-[11px] text-gray-500 hover:text-gray-300 transition-smooth"
          >
            Mark all seen
          </button>
        )}
      </div>

      {/* Content */}
      <div className="p-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <svg className="w-10 h-10 text-gray-600 mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            <p className="text-sm text-gray-500">No new episodes</p>
            <p className="text-xs text-gray-600 mt-1">Subscribe to shows to get notified</p>
          </div>
        ) : (
          <div className="space-y-1">
            {groups.map((group) => (
              <div key={group.subscriptionId} className="rounded-lg bg-surface-700/30 overflow-hidden">
                {/* Show header */}
                <div className="flex items-center gap-3 px-3 py-2.5 border-b border-surface-700/50">
                  {group.showThumb && (
                    <img loading="lazy" decoding="async"
                      src={group.showThumb}
                      alt={group.showTitle}
                      className="w-8 h-12 rounded object-cover flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-gray-200 truncate">
                      {group.showTitle}
                    </h4>
                    <p className="text-[11px] text-teal-400">
                      {group.alerts.length} new episode{group.alerts.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => handleMarkAllSeen(group.subscriptionId)}
                    className="text-[10px] text-gray-500 hover:text-gray-300 transition-smooth px-2 py-1 rounded hover:bg-surface-600"
                  >
                    Mark seen
                  </button>
                </div>

                {/* Episode list */}
                <div className="divide-y divide-surface-700/30">
                  {group.alerts.map((alert) => (
                    <div
                      key={alert.id}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-surface-700/50 transition-smooth group"
                    >
                      <span className="text-xs font-mono text-teal-400 w-14 flex-shrink-0">
                        {formatEpisode(alert.season_number, alert.episode_number)}
                      </span>
                      <span className="text-xs text-gray-300 flex-1 truncate">
                        {alert.episode_title}
                      </span>
                      <span className="text-[10px] text-gray-600 flex-shrink-0">
                        {timeAgo(alert.added_at || alert.created_at)}
                      </span>
                      <button
                        onClick={() => handleMarkSeen(alert.id)}
                        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-300 transition-smooth p-0.5"
                        title="Mark seen"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
