import React from 'react';
import {
  siImdb,
  siRottentomatoes,
  siLetterboxd,
  siThemoviedatabase,
  siMetacritic,
  siTrakt,
  siMdblist,
} from 'simple-icons';
import BrandIcon from './BrandIcon';

const configs = {
  imdb: {
    label: 'IMDb',
    brand: siImdb,
    bg: 'bg-imdb',
    text: 'text-black',
    format: (v) => v?.toFixed(1) ?? 'N/A',
  },
  rt: {
    label: 'RT',
    brand: siRottentomatoes,
    getBg: (v) => (v >= 60 ? 'bg-rt-fresh' : 'bg-rt-rotten'),
    text: 'text-white',
    format: (v) => (v != null ? `${Math.round(v)}%` : 'N/A'),
  },
  rtAudience: {
    label: 'Audience',
    emoji: '🍿', // popcorn — RT audience metric
    getBg: (v) => (v >= 60 ? 'bg-rt-fresh' : 'bg-rt-rotten'),
    text: 'text-white',
    format: (v) => (v != null ? `${Math.round(v)}%` : 'N/A'),
  },
  tmdb: {
    label: 'TMDB',
    brand: siThemoviedatabase,
    bg: 'bg-tmdb',
    text: 'text-white',
    format: (v) => v?.toFixed(1) ?? 'N/A',
  },
  metacritic: {
    label: 'MC',
    brand: siMetacritic,
    getBg: (v) => {
      if (v == null) return 'bg-gray-600';
      if (v >= 61) return 'bg-metacritic-green';
      if (v >= 40) return 'bg-metacritic-yellow';
      return 'bg-metacritic-red';
    },
    text: 'text-white',
    format: (v) => v?.toString() ?? 'N/A',
  },
  letterboxd: {
    label: 'LB',
    brand: siLetterboxd,
    bg: 'bg-letterboxd',
    text: 'text-letterboxd-green',
    format: (v) => v?.toFixed(1) ?? 'N/A',
  },
  trakt: {
    label: 'Trakt',
    brand: siTrakt,
    bg: 'bg-trakt',
    text: 'text-white',
    format: (v) => (v != null ? `${Math.round(v)}%` : 'N/A'),
  },
  mdblist: {
    label: 'MDB',
    brand: siMdblist,
    bg: 'bg-mdblist',
    text: 'text-white',
    format: (v) => (v != null ? `${Math.round(v)}` : 'N/A'),
  },
};

export default function RatingBadge({ value, type, size = 'sm', voteCount = null, lowConfidence = false }) {
  const config = configs[type];
  if (!config) return null;

  const isNA = value == null || value === 0;
  const sizeClasses = size === 'md' ? 'px-2 py-1 text-xs' : 'px-1.5 py-0.5 text-[10px]';
  const iconClass = size === 'md' ? 'w-3.5 h-3.5' : 'w-3 h-3';
  const title = voteCount != null
    ? `${config.label}: ${config.format(value)} from ${voteCount.toLocaleString()} vote${voteCount === 1 ? '' : 's'}${lowConfidence ? ' (low confidence)' : ''}`
    : `${config.label}: ${config.format(value)}${lowConfidence ? ' (low confidence)' : ''}`;

  if (isNA) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded ${sizeClasses} bg-gray-700 text-gray-400 font-medium`}
      >
        {config.brand ? (
          <BrandIcon icon={config.brand} className={iconClass} />
        ) : config.emoji ? (
          <span>{config.emoji}</span>
        ) : null}
        <span>N/A</span>
      </span>
    );
  }

  const bg = lowConfidence ? 'bg-gray-700' : (config.getBg ? config.getBg(value) : config.bg);
  const textColor =
    lowConfidence ? 'text-gray-200' : (type === 'metacritic' && value >= 40 && value < 61 ? 'text-black' : config.text);

  return (
    <span
      className={`inline-flex items-center gap-1 rounded ${sizeClasses} ${bg} ${textColor} font-bold whitespace-nowrap`}
      title={title}
    >
      {config.brand ? (
        <BrandIcon icon={config.brand} className={iconClass} />
      ) : config.emoji ? (
        <span>{config.emoji}</span>
      ) : null}
      <span>{config.format(value)}</span>
      {lowConfidence && <span className="text-[0.75em] opacity-80">low</span>}
    </span>
  );
}
