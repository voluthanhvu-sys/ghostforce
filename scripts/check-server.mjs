// Cross-platform syntax check for the backend entry point and every server module.
// `node --check server/*.js` relies on shell globbing, which Windows cmd.exe (used by
// npm scripts) does not perform, so the glob is expanded here in Node instead.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const serverDir = path.join(root, 'server');
const targets = ['ghostforge-server.js'];

if (fs.existsSync(serverDir)) {
  for (const name of fs.readdirSync(serverDir).filter((n) => n.endsWith('.js')).sort()) {
    targets.push(path.join('server', name));
  }
}

const failed = [];
for (const rel of targets) {
  try {
    execFileSync(process.execPath, ['--check', rel], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    failed.push(rel);
  }
}

if (failed.length) {
  console.error(`Syntax check FAILED for ${failed.length} file(s): ${failed.join(', ')}`);
  process.exit(1);
}

console.log(`Syntax check passed for ${targets.length} backend file(s).`);
