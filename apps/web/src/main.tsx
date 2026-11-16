import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import esES from 'antd/locale/es_ES';
import { AuthProvider } from './lib/auth';
import App from './App';
import { markChunkError, reloadOnce } from './lib/chunkErrors';
import './styles.css';

// Vite fires this when a module preload/dynamic import fails (e.g. old chunk
// hashes after a redeploy). Reload once with the new index.html.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  if (!reloadOnce()) markChunkError();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={esES}
      theme={{
        token: {
          colorPrimary: '#54c1c2',
          colorInfo: '#54c1c2',
          colorLink: '#2f9e9f',
          borderRadius: 6,
          fontFamily: '"Nunito Sans", "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif',
          colorText: '#262626',
          colorBgLayout: '#f5f7fa',
        },
        components: {
          Layout: { headerBg: '#1b1b34', siderBg: '#ffffff' },
          Table: { headerBg: '#fafafa', cellPaddingBlock: 8, cellPaddingInline: 10 },
          Button: { fontWeight: 600 },
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
