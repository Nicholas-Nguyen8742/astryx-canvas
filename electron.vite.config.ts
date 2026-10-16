import {resolve} from 'node:path';

import react from '@vitejs/plugin-react';
import {defineConfig, externalizeDepsPlugin} from 'electron-vite';

/**
 * `@astryxdesign/theme-neutral/fonts.css` is a single `@import url(...)` against
 * fonts.googleapis.com. The offline mandate (NFR-OFF-01/02/05) and the renderer
 * CSP (NFR-SEC-07) both forbid it, and the file is pulled in by the generated
 * root-level `astryx-themes.js`, which must not be hand-edited. Redirecting the
 * specifier here removes the network call at the bundler layer while leaving the
 * CLI-managed module byte-identical, so `astryx doctor`'s record check still passes.
 */
const offlineThemeFonts = resolve(
  __dirname,
  'src/renderer/src/styles/astryx-fonts.css'
);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {index: resolve(__dirname, 'src/main/index.ts')}
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // A sandboxed renderer requires a CommonJS preload script, but this
      // package is `"type": "module"`, so the output needs an explicit .cjs
      // extension to keep sandbox: true (NFR-SEC-03) viable.
      rollupOptions: {
        input: {index: resolve(__dirname, 'src/preload/index.ts')},
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@astryxdesign/theme-neutral/fonts.css': offlineThemeFonts
      }
    },
    plugins: [react()],
    server: {
      fs: {
        // The CLI-managed theme module lives at the project root, above the
        // renderer root, so the dev server has to be allowed to serve it.
        allow: [resolve(__dirname)]
      }
    },
    build: {
      rollupOptions: {
        input: {index: resolve(__dirname, 'src/renderer/index.html')}
      }
    }
  }
});
