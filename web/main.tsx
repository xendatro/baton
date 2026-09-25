import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { configureApi } from './lib/api';
import { createQueryClient } from './lib/queryClient';
import { queryKeys } from './lib/queryKeys';
import { createAppRouter } from './router';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

const queryClient = createQueryClient();
const router = createAppRouter();

// Auth errors navigate client-side, and a 401 clears the cached session so the guards re-check
// it. Configured before the first render, whose effects start the first requests.
configureApi({
  navigate: (to) => void router.navigate(to),
  onUnauthorized: () => queryClient.setQueryData(queryKeys.session(), null),
});

createRoot(container).render(
  <StrictMode>
    <App queryClient={queryClient} router={router} />
  </StrictMode>,
);
