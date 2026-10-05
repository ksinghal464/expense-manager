import { createRoot } from 'react-dom/client';
import './client/tokens.css';
import './client/base.css';
import './client/extra.css';
import App from './client/App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(<App />);

// Installable app + offline shell (public/sw.js). Production only, so the Vite
// dev server never serves cached files.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
