const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'pack-extension.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  fs.appendFileSync(logFile, line);
}

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  log('stdin ended, raw length=', d.length);
  log('stdin raw=', d.substring(0, 2000));

  try {
    const j = JSON.parse(d);
    log('parsed json keys=', Object.keys(j));

    const f = j.tool_input?.file_path || j.tool_response?.filePath;
    log('extracted file_path=', f);

    const matched = f && /background\.js|content\.js|inject\.js|popup\.js|popup\.html|manifest\.json|lib\/.*\.js$/.test(f);
    log('regex matched=', matched);

    if (matched) {
      const { execSync } = require('child_process');
      const cwd = path.dirname(path.dirname(__filename));
      log('exec npm run pack:edge in cwd=', cwd);
      try {
        execSync('npm run pack:edge', { cwd, stdio: 'pipe', encoding: 'utf-8' });
        log('pack:edge success');
      } catch (execErr) {
        log('pack:edge failed', execErr.message, execErr.stdout, execErr.stderr);
      }
    }
  } catch (e) {
    log('error', e.message, e.stack);
  }
});
