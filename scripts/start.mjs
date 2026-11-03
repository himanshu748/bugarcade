import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, '.venv', 'bin', 'python');
if (!existsSync(python)) { console.error('Python environment missing. Run: uv sync --extra dev'); process.exit(1); }
const processes = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill('SIGTERM');
  const killTimer = setTimeout(() => { for (const child of processes) child.kill('SIGKILL'); process.exit(code); }, 5000);
  killTimer.unref();
  Promise.all(processes.map(child => new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)))).then(() => process.exit(code));
}
for (const [command, args] of [[process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1']], [process.execPath, ['worker/server.mjs']], [python, ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000']]]) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  processes.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('BugArcade starts at http://127.0.0.1:5173 — Ctrl+C stops all three services.');
