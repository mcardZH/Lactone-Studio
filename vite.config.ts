import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve, dirname, basename } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// Match this project's generated directories, not a parent .cache containing
// the isolated candidate itself. A broad **/.cache/** would hide source edits.
const generatedDirectories = ['.cache', '.private', 'tests/evidence', 'tests/gaussian', 'tests/iterations', 'test-results'].map(path => resolve(import.meta.dirname, path).replaceAll('\\', '/') + '/**');
// Preserve the locked Vite defaults and keep internal archives/fixtures outside
// the development HTTP surface as well as outside the production bundle.
const privateFiles = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
  '**/.private/**', '**/tests/gaussian/**', '**/tests/iterations/**'];

const cache = resolve(import.meta.dirname, '.cache');
const publicPointer = resolve(cache, 'desktop-public.json');
const preparedPublic = existsSync(publicPointer) ? JSON.parse(readFileSync(publicPointer, 'utf8')) as {schema: number; directory: string} : null;
if (preparedPublic && (preparedPublic.schema !== 1 || dirname(preparedPublic.directory) !== cache || !/^desktop-public-[\w-]+$/.test(basename(preparedPublic.directory))))
  throw new Error('Invalid desktop public assets pointer; run npm run prepare:runtime.');
const desktopPublic = preparedPublic?.directory ?? resolve(cache, 'desktop-public-unprepared');

export default defineConfig({
  // Ketcher 3.18 uses `global` for its UI state and browser FileReader/Blob.
  // assert@2 -> util@0.12.5 also reads three Node diagnostic fields. Map the
  // browser's existing global and absent diagnostics, without a process shim.
  define: { global: 'globalThis', 'process.env.NODE_DEBUG': '""', 'process.stderr': 'undefined', 'process.emitWarning': 'undefined' },
  resolve: { alias: {
    'events': resolve(import.meta.dirname, 'node_modules/events/events.js'),
    'element-closest-polyfill': resolve(import.meta.dirname, 'src/web/modeling/two-d-native-dom.ts'),
    'ketcher-macromolecules': resolve(import.meta.dirname, 'src/web/modeling/two-d-editor-disabled-macro.tsx'),
    'miew-react': resolve(import.meta.dirname, 'src/web/modeling/two-d-editor-disabled-macro.tsx'),
  } },
  plugins: [react(), {
    name: 'require-selected-desktop-assets',
    apply: 'build',
    buildStart() {
      if (!existsSync(resolve(desktopPublic, 'ketcher/indigo-ketcher-LICENSE.txt')))
        throw new Error('Desktop runtime assets are not prepared; run npm run prepare:runtime.');
    },
  }],
  publicDir: desktopPublic,
  // A patched locked dependency must not reuse the old unpatched prebundle.
  // Keep the former cache intact and scope this cache to the public seam version.
  cacheDir: resolve(import.meta.dirname, '.cache/vite-bond-primitives-v1'),
  base: './',
  server: { host: '127.0.0.1', port: 4173, strictPort: true, fs: { deny: privateFiles }, watch: { ignored: generatedDirectories } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
