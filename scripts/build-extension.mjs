import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist-extension');

if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(distDir, { recursive: true });

const entries = [
  'manifest.json',
  'background.js',
  'content.js',
  'inject.js',
  'popup.html',
  'popup.js',
  'README.md',
  'icons',
  'lib',
];

for (const entry of entries) {
  const src = join(root, entry);
  if (!existsSync(src)) {
    console.warn(`[build:extension] 跳过不存在的入口: ${entry}`);
    continue;
  }
  const dst = join(distDir, entry);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

console.log('[build:extension] 已输出到:', distDir);
