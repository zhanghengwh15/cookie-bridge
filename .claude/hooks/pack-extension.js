let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(d);
    const f = j.tool_input?.file_path || j.tool_response?.filePath;
    if (f && /background\.js|content\.js|inject\.js|popup\.js|popup\.html|manifest\.json|lib\/.*\.js$/.test(f)) {
      const { execSync } = require('child_process');
      const cwd = require('path').dirname(require('path').dirname(__filename));
      execSync('npm run pack:edge', { cwd, stdio: 'inherit' });
    }
  } catch (e) {
    // ignore
  }
});
