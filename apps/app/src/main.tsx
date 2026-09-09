/**
 * The composition root of the SPA.
 *
 * Everything with a lifecycle is constructed HERE and nowhere else — the Query cache, the router,
 * the optional analytics/error-reporting providers. Every other module in this app is a pure
 * function of what it is given, which is what lets the guards and the kernel be tested without a
 * browser (ADR-0005's composition-root rule, in its frontend form).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { createAppRouter } from './router.js';

const queryClient = new QueryClient();
const router = createAppRouter({ queryClient });

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html is missing the #root mount point');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
