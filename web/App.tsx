import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from 'react-router/dom';
import type { createAppRouter } from './router';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';

export interface AppProps {
  queryClient: QueryClient;
  router: ReturnType<typeof createAppRouter>;
}

/** Root providers: data, tooltips, routing and toasts. */
export function App({ queryClient, router }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
