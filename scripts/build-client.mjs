import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['client/lobehub-rich.jsx'],
  outfile: 'public/lobehub-rich.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  external: ['./markdown.js'],
  legalComments: 'external',
  metafile: true,
});

// piscord serves this bundle to a bare page with only its same-directory
// imports beside it (test/piscord-renderer-contract.test.ts); anything else the
// bundle imports would 404 there and turn every Discord table back into text.
for (const { path, external } of result.metafile.outputs['public/lobehub-rich.js'].imports) {
  if (external && !/^\.\/[\w.-]+\.js$/.test(path))
    throw new Error(`public/lobehub-rich.js imports ${path}; keep externals to ./name.js beside it`);
}

// Preserve full bundled-package license notices as well as esbuild's comments.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  const parts = input.split('node_modules/');
  const tail = parts.at(-1).split('/');
  const name = tail[0].startsWith('@') ? tail.slice(0, 2).join('/') : tail[0];
  packages.add(parts.slice(0, -1).join('node_modules/') + 'node_modules/' + name);
}
let notices = '# Bundled LobeHub Streamdown dependencies\n\n';
for (const path of [...packages].sort()) {
  const dir = resolve(root, path);
  const pkg = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'));
  const files = (await readdir(dir)).filter((file) =>
    /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(file),
  );
  notices += `\n## ${pkg.name}@${pkg.version} (${pkg.license ?? 'see notice'})\n`;
  if (!files.length) {
    // remark-math's published subpackages put their copyright and license link
    // in readme.md instead of shipping the monorepo's license file.
    const readme = await readFile(resolve(dir, 'readme.md'), 'utf8');
    if (pkg.license !== 'MIT' || !/## License/i.test(readme))
      throw new Error(`Missing license notice for ${pkg.name}`);
    notices +=
      readme +
      '\n' +
      (await readFile(resolve(root, 'LICENSE'), 'utf8')).replace(
        /^[\s\S]*?(?=Permission is hereby granted)/,
        '',
      ) +
      '\n';
  }
  for (const file of files.sort())
    notices += '\n' + (await readFile(resolve(dir, file), 'utf8')) + '\n';
}
await writeFile(resolve(root, 'public/lobehub-rich.LICENSE.txt'), notices);
console.log(`Built LobeHub reply island and ${packages.size} dependency license notices.`);

// Komorebi voice input SDK (git submodule). Served as plain files, not bundled:
// the SDK loads its audio worklet and worker by URLs relative to itself.
const sdk = resolve(root, 'third_party/komorebi-voice/sdk/js');
const sdkFiles = (await readdir(sdk).catch(() => {
  throw new Error('Komorebi SDK missing: run `git submodule update --init third_party/komorebi-voice`');
})).filter((file) => file.endsWith('.js'));
const sdkOut = resolve(root, 'public/komorebi');
await rm(sdkOut, { recursive: true, force: true });
await mkdir(sdkOut, { recursive: true });
for (const file of sdkFiles) await copyFile(resolve(sdk, file), resolve(sdkOut, file));
console.log(`Copied ${sdkFiles.length} Komorebi voice SDK modules.`);
