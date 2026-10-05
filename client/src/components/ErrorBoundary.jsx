import React from 'react';

/**
 * Catches a crash while drawing the page. Without it, one title with odd data
 * that breaks a card blanks the whole app to an empty screen. With it, the
 * person sees what happened and a button that gets them back.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('Heldover hit a display error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-900 text-center px-4">
        <div className="space-y-3 max-w-sm">
          <p className="text-4xl">🎬</p>
          <p className="text-gray-100 font-semibold">Something on this page went wrong.</p>
          <p className="text-gray-400 text-sm">Reloading usually fixes it. Your lists and settings are safe.</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 rounded-lg bg-surface-700 text-gray-100 text-sm">
            Reload
          </button>
        </div>
      </div>
    );
  }
}
