import { createRoot } from 'react-dom/client';
import './client/tokens.css';
import './client/base.css';
import './client/extra.css';
import App from './client/App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(<App />);
