import React from 'react';
import { useAvailability } from '../lib/availability';

/**
 * "Also on Netflix" chips. Shows the subscription services carrying a title, so
 * you can see at a glance that the 4K file you were about to stream from a
 * shared server is sitting in your own Netflix account.
 */
export default function StreamingBadges({ item, size = 'sm', max = 3, className = '', credit = false }) {
  const availability = useAvailability(item);
  const services = availability?.streaming || [];

  if (services.length === 0) return null;

  const shown = services.slice(0, max);
  const overflow = services.length - shown.length;

  const pad =
    size === 'xs' ? 'px-1 py-[1px] text-[8px]' : size === 'md' ? 'px-2 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[9px]';

  return (
    <div className={`flex gap-1 flex-wrap items-center ${className}`}>
      {shown.map((service) => (
        <span
          key={service.id}
          title={`Streaming on ${service.name}`}
          className={`${pad} rounded font-bold text-white shadow-sm whitespace-nowrap`}
          style={{ backgroundColor: service.color }}
        >
          {service.name}
        </span>
      ))}
      {overflow > 0 && (
        <span className={`${pad} rounded font-bold bg-black/70 text-gray-300 border border-gray-600`}>
          +{overflow}
        </span>
      )}
      {/* TMDB gets "which service streams this" from JustWatch and makes
          naming them a condition of using it. Sits on its own line under the
          chips; the poster cards are too small for it, so they leave it off. */}
      {credit && (
        <a
          href="https://www.justwatch.com"
          target="_blank"
          rel="noreferrer"
          className="basis-full text-[10px] text-gray-500 hover:text-gray-300 transition-smooth"
        >
          Streaming availability by JustWatch
        </a>
      )}
    </div>
  );
}
