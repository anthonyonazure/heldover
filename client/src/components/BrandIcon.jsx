import React from 'react';

export default function BrandIcon({ icon, className = 'w-3 h-3' }) {
  if (!icon || !icon.path) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      role="img"
    >
      <path d={icon.path} />
    </svg>
  );
}
