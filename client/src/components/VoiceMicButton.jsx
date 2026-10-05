import React, { useState, useRef } from 'react';
import { parseVoice } from '../lib/api';

const SpeechRecognition =
  (typeof window !== 'undefined') &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

export default function VoiceMicButton({ onParsed }) {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);

  if (!SpeechRecognition) return null;

  const start = () => {
    setError(null);
    setTranscript('');
    const rec = new SpeechRecognition();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      setTranscript(text);
    };
    rec.onerror = (event) => {
      setError(event.error || 'voice error');
      setListening(false);
    };
    rec.onend = async () => {
      setListening(false);
      const finalText = (transcript || '').trim() || (rec._lastTranscript || '');
      if (!finalText) return;
      try {
        const parsed = await parseVoice(finalText);
        onParsed && onParsed(parsed);
      } catch (err) {
        setError(err.message);
      }
    };
    // capture final transcript via spread, recognition gets re-assigned
    rec.addEventListener('result', (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
      rec._lastTranscript = text;
    });
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  };

  const stop = () => {
    if (recognitionRef.current) recognitionRef.current.stop();
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={listening ? stop : start}
        title={listening ? 'Listening… tap to stop' : 'Voice search'}
        className={`p-2 rounded-lg transition-colors ${
          listening
            ? 'bg-red-500 text-white animate-pulse'
            : 'bg-surface-800 text-gray-300 hover:text-amber-400 hover:bg-surface-700 border border-surface-700'
        }`}
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 0014 0h-2zm-5 7a1 1 0 100 2 1 1 0 000-2zm-1-2h2v4h-2z" />
        </svg>
      </button>
      {(listening || transcript) && (
        <div className="absolute top-full right-0 mt-2 px-3 py-1.5 bg-surface-800 border border-surface-700 rounded-lg text-xs text-gray-200 whitespace-nowrap max-w-[280px] truncate shadow-lg z-50">
          {transcript || 'Listening…'}
        </div>
      )}
      {error && (
        <div className="absolute top-full right-0 mt-2 px-3 py-1.5 bg-red-900/80 border border-red-700 rounded-lg text-xs text-red-100 z-50">
          {error}
        </div>
      )}
    </div>
  );
}
