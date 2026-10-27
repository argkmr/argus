import { defineConfig } from 'vite';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, '..');
let outputDirectory = path.join(root, 'dist');

export default defineConfig({
  root,
  publicDir: path.join(root, 'public'),
  esbuild: { jsx: 'automatic' },
  resolve: { dedupe: ['react', 'react-dom', '@xyflow/react', 'yjs'] },
  optimizeDeps: { exclude: ['@excalidraw/excalidraw'] },
  server: { host: '127.0.0.1', port: 4187, fs: { allow: [repository] } },
  preview: { host: '127.0.0.1', port: 4187 },
  build: { outDir: path.join(root, 'dist'), emptyOutDir: true, sourcemap: false },
  plugins: [{
    name: 'local-excalidraw-fonts',
    configResolved(config) { outputDirectory = config.build.outDir; },
    transform(code, id) {
      if (!id.includes('/@excalidraw/excalidraw/') || !code.includes('https://esm.sh/')) return;
      // 0.18.1 always adds a CDN fallback even with EXCALIDRAW_ASSET_PATH.
      // FontFace validates every source against CSP immediately; make its
      // fallback local too, without relaxing the standalone site's policy.
      const local = code.replace(/`https:\/\/esm\.sh\/\$\{[^;]+?\/dist\/prod\/`/g, "new URL('/assets/excalidraw/', window.location.origin).href");
      return { code: local, map: null };
    },
    configureServer(server) {
      server.middlewares.use('/assets/excalidraw/', async (request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const category = pathname.startsWith('/fonts/') ? 'fonts' : pathname.startsWith('/licenses/') ? 'licenses' : '';
        if (!category) { next(); return; }
        const source = category === 'fonts' ? path.join(repository, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts') : path.join(repository, 'docs/third-party/diagram-studio');
        const file = path.resolve(source, pathname.slice(category.length + 2));
        if (!file.startsWith(source + path.sep)) { response.writeHead(404).end(); return; }
        try { const contents = await readFile(file); response.setHeader('Content-Type', file.endsWith('.woff2') ? 'font/woff2' : 'text/plain'); response.end(contents); }
        catch { response.writeHead(404).end(); }
      });
    },
    async closeBundle() {
      const assets = path.join(outputDirectory, 'assets/excalidraw');
      await mkdir(assets, { recursive: true });
      await cp(path.join(repository, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts'), path.join(assets, 'fonts'), { recursive: true });
      await cp(path.join(repository, 'docs/third-party/diagram-studio'), path.join(assets, 'licenses'), { recursive: true });
      await cp(path.join(repository, 'public/licenses'), path.join(assets, 'licenses'), { recursive: true });
    },
  }],
});
