import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getQueueItems, removeFromQueue, reorderQueue } from '../lib/api';
import RatingBadge from './RatingBadge';
import { reportProblem } from '../lib/notice';

function QueueCard({ item, index, onRemove, onMoveUp, onMoveDown, isFirst, isLast }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const posterUrl = item.thumb;
  const genres = item.genres || [];

  return (
    <div className={`relative group flex gap-4 p-3 rounded-lg border transition-all duration-300 hover:shadow-lg hover:shadow-black/20 ${
      isFirst
        ? 'bg-[#06B6D4]/10 border-[#06B6D4]/30'
        : 'bg-surface-800 border-surface-700 hover:border-surface-600'
    }`}>
      {/* Position number */}
      <div className="flex flex-col items-center justify-center gap-1 w-8 shrink-0">
        <button
          onClick={() => onMoveUp(item)}
          disabled={isFirst}
          className="p-0.5 rounded hover:bg-surface-600 text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-20 disabled:cursor-default"
          title="Move up"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
        <span className={`text-sm font-bold ${isFirst ? 'text-[#06B6D4]' : 'text-gray-500'}`}>
          {index + 1}
        </span>
        <button
          onClick={() => onMoveDown(item)}
          disabled={isLast}
          className="p-0.5 rounded hover:bg-surface-600 text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-20 disabled:cursor-default"
          title="Move down"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Poster thumbnail */}
      <div className="w-16 h-24 shrink-0 rounded overflow-hidden bg-surface-700">
        {!imgError && posterUrl ? (
          <img
            src={posterUrl}
            alt={item.title}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            className={`w-full h-full object-cover transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
            </svg>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-100 truncate" title={item.title}>
              {isFirst && (
                <span className="inline-block text-[9px] font-bold bg-[#06B6D4]/20 text-[#06B6D4] px-1.5 py-0.5 rounded mr-2 uppercase">
                  Up Next
                </span>
              )}
              {item.title}
            </h3>
            <div className="flex items-center gap-2 mt-0.5">
              {item.year && <span className="text-xs text-gray-500">{item.year}</span>}
              {item.type && <span className="text-[10px] text-gray-600 uppercase">{item.type}</span>}
            </div>
          </div>
          <button
            onClick={() => onRemove(item)}
            className="shrink-0 p-1.5 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
            title="Remove from queue"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Rating badges */}
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {item.imdb_rating != null && <RatingBadge value={item.imdb_rating} type="imdb" size="sm" />}
          {item.rotten_tomatoes != null && <RatingBadge value={item.rotten_tomatoes} type="rt" size="sm" />}
        </div>

        {/* Genres */}
        {genres.length > 0 && (
          <div className="flex gap-1 mt-1.5 overflow-hidden">
            {genres.slice(0, 3).map((g) => (
              <span key={g} className="px-1.5 py-0.5 rounded text-[9px] bg-surface-700 text-gray-500 truncate">
                {g}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WatchLaterQueue({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getQueueItems();
      setItems(data.items || []);
    } catch (err) {
      reportProblem("Couldn't load your queue.", err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleRemove = async (item) => {
    try {
      await removeFromQueue(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err) {
      reportProblem("Couldn't remove that from your queue. Try again.", err);
    }
  };

  const handleMoveUp = async (item) => {
    const index = items.findIndex((i) => i.id === item.id);
    if (index <= 0) return;
    try {
      await reorderQueue(item.id, index - 1);
      // Optimistic reorder
      const newItems = [...items];
      [newItems[index - 1], newItems[index]] = [newItems[index], newItems[index - 1]];
      setItems(newItems);
    } catch (err) {
      reportProblem("Couldn't save the new order. Try again.", err);
      fetchItems();
    }
  };

  const handleMoveDown = async (item) => {
    const index = items.findIndex((i) => i.id === item.id);
    if (index >= items.length - 1) return;
    try {
      await reorderQueue(item.id, index + 1);
      // Optimistic reorder
      const newItems = [...items];
      [newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]];
      setItems(newItems);
    } catch (err) {
      reportProblem("Couldn't save the new order. Try again.", err);
      fetchItems();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-900">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface-900/95 backdrop-blur-sm border-b border-surface-700">
        <div className="flex items-center justify-between px-4 py-3 max-w-3xl mx-auto">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 text-[#06B6D4]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 4a1 1 0 011 1v4.586l2.707 2.707a1 1 0 01-1.414 1.414l-3-3A1 1 0 0111 12V7a1 1 0 011-1z" />
            </svg>
            <div>
              <h1 className="text-lg font-bold text-gray-100">Watch Later</h1>
              <p className="text-xs text-gray-500">{items.length} item{items.length !== 1 ? 's' : ''} in queue</p>
            </div>
          </div>
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
      <div className="flex-1 overflow-y-auto p-4 max-w-3xl mx-auto w-full">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-4 p-3 rounded-lg bg-surface-800 border border-surface-700 animate-pulse">
                <div className="w-8 h-24 bg-surface-700 rounded" />
                <div className="w-16 h-24 bg-surface-700 rounded" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-surface-700 rounded w-3/4" />
                  <div className="h-3 bg-surface-700 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <svg className="w-16 h-16 text-gray-700 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1}>
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h3 className="text-lg font-medium text-gray-400 mb-1">Your queue is empty</h3>
            <p className="text-sm text-gray-600">
              Add shows and movies to watch later.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item, index) => (
              <QueueCard
                key={item.id}
                item={item}
                index={index}
                onRemove={handleRemove}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                isFirst={index === 0}
                isLast={index === items.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
