import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// ponytail: no StrictMode -- its double-invoked effects would register the
// `sessions` IPC listener twice in dev, and this app has no other use for it.
createRoot(document.getElementById('root')).render(<App />);
