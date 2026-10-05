/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter Variable',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      colors: {
        surface: {
          950: '#06070d',
          900: '#0a0b14',
          850: '#0e0f1a',
          800: '#161824',
          700: '#222637',
          600: '#2e334a',
          500: '#3d4258',
        },
        accent: {
          DEFAULT: '#f5c518',
          dark: '#d4a800',
          light: '#ffe066',
        },
        imdb: '#f5c518',
        rt: {
          fresh: '#66cc33',
          rotten: '#fa320a',
        },
        tmdb: '#01b4e4',
        metacritic: {
          green: '#66cc33',
          yellow: '#ffcc33',
          red: '#ff0000',
        },
        letterboxd: {
          DEFAULT: '#202830',
          green: '#00e054',
          orange: '#ff8000',
          blue: '#40bcf4',
        },
        trakt: '#ed1c24',
        mdblist: '#7e3ff2',
      },
      gridTemplateColumns: {
        'auto-fill-poster': 'repeat(auto-fill, minmax(160px, 1fr))',
        'auto-fill-poster-lg': 'repeat(auto-fill, minmax(200px, 1fr))',
      },
    },
  },
  plugins: [],
};
