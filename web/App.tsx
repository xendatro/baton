import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from 'react-router/dom';
import type { createAppRouter } from './router';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';

export type AppRouter = ReturnType<typeof createAppRouter>;

export interface AppProps {
  queryClient: QueryClient;
  router: AppRouter;
}

/**
 * Root providers: data, tooltips, routing and toasts. The theme needs no provider: it is a
 * small external store (web/lib/theme.ts) applied before first paint by public/theme-init.js.
 */
export function App({ queryClient, router }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
