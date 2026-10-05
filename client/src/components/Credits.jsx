import React from 'react';
import tmdbLogo from '../assets/tmdb.svg';

const linkClass = 'underline decoration-gray-600 underline-offset-2 hover:text-gray-300';

function Source({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
      {children}
    </a>
  );
}

/**
 * Who the data comes from. TMDB, JustWatch and OMDb each make this credit a
 * condition of using their data, so it shows to every viewer, not only the
 * owner. The TMDB sentence is their required wording: keep it word for word.
 * Their logo is the official file from themoviedb.org, unaltered, and has to
 * stay smaller than the app's own name.
 */
export default function Credits() {
  return (
    <div className="px-5 pb-5">
      <div className="pt-4 border-t border-surface-700 space-y-2 text-[11px] text-gray-500 leading-relaxed">
        <h3 className="text-xs font-bold text-gray-400">Credits</h3>
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="inline-block">
          <img src={tmdbLogo} alt="TMDB" className="h-3 w-auto" />
        </a>
        <p className="text-gray-400">
          This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.
        </p>
        <p>
          Streaming availability by <Source href="https://www.justwatch.com">JustWatch</Source>.
          {' '}Ratings data from <Source href="https://www.omdbapi.com">OMDb</Source>
          {' '}(<Source href="https://creativecommons.org/licenses/by-nc/4.0/">CC BY-NC 4.0</Source>).
          {' '}More scores from <Source href="https://mdblist.com">MDBList</Source>.
          {' '}Backdrops and logos from <Source href="https://fanart.tv">Fanart.tv</Source>.
        </p>
        <p>Heldover is an independent project. It is not affiliated with or endorsed by Plex, Inc.</p>
      </div>
    </div>
  );
}
