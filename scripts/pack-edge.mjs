import { createWriteStream, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist-extension');
const zipFile = join(root, 'cookie-bridge-edge-extension.zip');
const manifestPath = join(distDir, 'manifest.json');
const popupHtml = join(distDir, 'popup.html');

if (!existsSync(distDir)) {
  console.error('未找到 dist-extension，请先执行 npm run build:extension');
  process.exit(1);
}

if (!existsSync(popupHtml)) {
  console.error('扩展包中缺少 popup.html，弹窗入口不正确');
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  console.error('扩展包中缺少 manifest.json');
  process.exit(1);
}

try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const popup = manifest?.action?.default_popup;
  if (popup !== 'popup.html') {
    console.error(`manifest 中 action.default_popup 应为 "popup.html"，当前为: ${JSON.stringify(popup)}`);
    process.exit(1);
  }
} catch (e) {
  console.error('无法解析 dist-extension/manifest.json', e);
  process.exit(1);
}

if (existsSync(zipFile)) {
  rmSync(zipFile);
}

const output = createWriteStream(zipFile);
const archive = archiver('zip', { zlib: { level: 9 } });

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);
archive.directory(distDir, false);

await archive.finalize();
console.log('已生成:', zipFile);
