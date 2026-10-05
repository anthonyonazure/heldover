import React from 'react';

const resolutionConfig = {
  '4k': { label: '4K', className: 'bg-purple-600 text-white' },
  '2160': { label: '4K', className: 'bg-purple-600 text-white' },
  '2160p': { label: '4K', className: 'bg-purple-600 text-white' },
  '1080': { label: '1080p', className: 'bg-blue-600 text-white' },
  '1080p': { label: '1080p', className: 'bg-blue-600 text-white' },
  '720': { label: '720p', className: 'bg-gray-500 text-white' },
  '720p': { label: '720p', className: 'bg-gray-500 text-white' },
  '480p': { label: '480p', className: 'bg-gray-600 text-white' },
  '480': { label: '480p', className: 'bg-gray-600 text-white' },
  sd: { label: 'SD', className: 'bg-gray-600 text-white' },
};

export default function QualityBadge({ resolution, hdr, audioCodec }) {
  const badges = [];

  if (resolution) {
    const key = String(resolution).toLowerCase();
    const config = resolutionConfig[key];
    if (config) {
      badges.push(config);
    }
  }

  if (hdr) {
    badges.push({ label: 'HDR', className: 'bg-amber-500 text-black' });
  }

  if (audioCodec) {
    const codec = String(audioCodec).toLowerCase();
    if (codec.includes('atmos') || codec.includes('truehd')) {
      badges.push({ label: 'Atmos', className: 'bg-green-600 text-white' });
    } else if (codec.includes('dts')) {
      badges.push({ label: 'DTS', className: 'bg-green-700 text-white' });
    }
  }

  if (badges.length === 0) return null;

  return (
    <div className="flex gap-0.5">
      {badges.map((b, i) => (
        <span
          key={i}
          className={`px-1 py-0.5 rounded text-[8px] font-bold leading-none ${b.className}`}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
}
