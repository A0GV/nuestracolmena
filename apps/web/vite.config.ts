import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4100',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/') || id.includes('/react-router')) return 'react-vendor';
          if (id.includes('/recharts/') || id.includes('/d3-') || id.includes('/victory-vendor/')) return 'charts-vendor';
          if (
            id.includes('/react-markdown/') || id.includes('/remark-') || id.includes('/rehype-')
            || id.includes('/micromark') || id.includes('/mdast') || id.includes('/unist')
            || id.includes('/unified/') || id.includes('/hast') || id.includes('/vfile')
            || id.includes('/bail/') || id.includes('/trough/') || id.includes('/devlop/')
            || id.includes('/ccount/') || id.includes('/character-entities')
            || id.includes('/property-information/') || id.includes('/space-separated-tokens/')
            || id.includes('/comma-separated-tokens/') || id.includes('/decode-named-character-reference/')
            || id.includes('/html-url-attributes/') || id.includes('/longest-streak/')
            || id.includes('/markdown-table/') || id.includes('/trim-lines/') || id.includes('/zwitch/')
            || id.includes('/estree-util') || id.includes('/style-to-')
          ) return 'markdown-vendor';
          if (id.includes('/axios/') || id.includes('/dayjs/') || id.includes('/@tanstack/')) return 'utils-vendor';
          return undefined;
        },
      },
    },
  },
});
