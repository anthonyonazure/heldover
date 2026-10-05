import React, { useState, useEffect } from 'react';
import { checkSubscription, subscribeToShow, unsubscribeFromShow, getSubscriptions } from '../lib/api';
import { reportProblem } from '../lib/notice';

export default function SubscribeButton({ item, size = 'sm' }) {
  const [subscribed, setSubscribed] = useState(false);
  const [subId, setSubId] = useState(null);
  const [loading, setLoading] = useState(false);

  const plexKey = item?.ratingKey || item?.key;

  // Only show for TV shows
  if (item?.type !== 'show') return null;

  useEffect(() => {
    if (!plexKey) return;
    let cancelled = false;
    checkSubscription(plexKey)
      .then((data) => {
        if (cancelled) return;
        setSubscribed(!!data.subscribed);
      })
      .catch(() => {});

    // Also get the subscription ID if subscribed
    getSubscriptions()
      .then((data) => {
        if (cancelled) return;
        const subs = data.subscriptions || [];
        const match = subs.find((s) => String(s.plex_key) === String(plexKey));
        if (match) {
          setSubId(match.id);
          setSubscribed(true);
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [plexKey]);

  const handleClick = async (e) => {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);

    try {
      if (subscribed && subId) {
        await unsubscribeFromShow(subId);
        setSubscribed(false);
        setSubId(null);
      } else {
        const data = await subscribeToShow({
          title: item.title,
          plexKey,
          serverKey: item.serverKey,
          libraryKey: item.libraryKey,
          guid: item.guid,
          thumb: item.posterUrl || item.thumb,
        });
        setSubscribed(true);
        if (data.subscription) {
          setSubId(data.subscription.id);
        }
      }
    } catch (err) {
      reportProblem("Couldn't change episode alerts for this show. Try again.", err);
    } finally {
      setLoading(false);
    }
  };

  const isSm = size === 'sm';

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`
        ${isSm
          ? 'p-1.5 rounded-md'
          : 'p-2.5 rounded-lg'
        }
        transition-smooth disabled:opacity-50
        ${subscribed
          ? 'bg-teal-500/20 text-teal-400 border border-teal-500/30 hover:bg-teal-500/30'
          : 'bg-surface-700/80 text-gray-400 border border-surface-600 hover:text-teal-400 hover:border-teal-500/30'
        }
      `}
      title={subscribed ? 'Unsubscribe from new episodes' : 'Subscribe to new episodes'}
    >
      {subscribed ? (
        <svg className={isSm ? 'w-4 h-4' : 'w-5 h-5'} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C7.58 2 4 5.58 4 10v4.17l-1.71 1.71A1 1 0 003 17h18a1 1 0 00.71-1.71L20 14.17V10c0-4.42-3.58-8-8-8zm0 22a2 2 0 002-2h-4a2 2 0 002 2z" />
        </svg>
      ) : (
        <svg className={isSm ? 'w-4 h-4' : 'w-5 h-5'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
      )}
    </button>
  );
}
