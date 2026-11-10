import { defineConfig } from 'astro/config';

export default defineConfig({
  server: { host: '127.0.0.1', port: 4322 },
  vite: {
    server: { strictPort: true },
    plugins: [{
      name: 'local-region-editor-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/api/editor/')) { next(); return; }
          // Vite reloads API modules on edits while keeping their state between requests.
          server.ssrLoadModule('/server/api.ts').then(({ editorApi }) => editorApi(req, res, next)).catch(next);
        });
      },
    }],
  },
});
