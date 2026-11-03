import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Compile browser code using only the image's pinned React installation. */
export function bundleReactApp({ appPath, entry, minify = false, sourcemap = 'inline' }) {
  const canonicalAppPath = realpathSync(appPath);
  return build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    nodePaths: [path.join(root, 'node_modules')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    minify,
    sourcemap,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    plugins: [{
      name: 'restrict-app-imports',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.importer === canonicalAppPath && !['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'].includes(args.path)) {
            return { errors: [{ text: 'Only React imports are supported' }] };
          }
          return undefined;
        });
      },
    }],
  });
}
