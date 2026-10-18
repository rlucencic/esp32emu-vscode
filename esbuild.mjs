// Bundles the extension (and its debug adapter, which runs inside it) into dist/extension.js
import * as esbuild from 'esbuild';

const minify = process.argv.includes('--minify');
await esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !minify,
    minify,
});
