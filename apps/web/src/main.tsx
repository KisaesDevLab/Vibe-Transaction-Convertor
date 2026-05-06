import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { ToastProvider } from './components/Toast';
import { queryClient } from './lib/query';
import './styles/index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/*
        basename: react-router needs to know the path prefix the SPA is
        served under so client-side navigation stays inside it. Vite's
        `base` build option populates import.meta.env.BASE_URL — "/" in
        standalone deploys (no-op) and "/<slug>/" behind the
        Vibe-Appliance shared Caddy in LAN / Tailscale modes (the
        entrypoint sed-replaces /__VIBE_BASE_PATH__/ in the built
        bundle). Without this, <Navigate to="/login" /> escapes the
        prefix and the browser ends up at /login instead of /<slug>/login.
      */}
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
