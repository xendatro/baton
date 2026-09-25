import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createQueryClient } from './lib/queryClient';
import { createAppRouter } from './router';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App queryClient={createQueryClient()} router={createAppRouter()} />
  </StrictMode>,
);
