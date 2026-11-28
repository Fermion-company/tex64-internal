import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function contains(directory, target) {
  const relative = path.relative(directory, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function resolveOutputPath(target) {
  if (fs.existsSync(target)) return fs.realpathSync(target);
  return path.join(resolveOutputPath(path.dirname(target)), path.basename(target));
}

export function prepareRunWorkspace(requested, sandbox) {
  const source = fs.realpathSync(sandbox);
  const target = resolveOutputPath(path.resolve(requested));
  if (contains(source, target)) throw new Error('RUN_DIR must be outside the source manuscript');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  let run = target;
  try {
    fs.mkdirSync(run);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    run = fs.mkdtempSync(path.join(target, 'run-'));
  }
  const project = path.join(run, 'project');
  fs.cpSync(source, project, {
    recursive: true,
    dereference: true,
    filter(file) {
      // Edits must stay inside the copy, including when fixture files are linked.
      if (fs.lstatSync(file).isSymbolicLink() && !contains(source, fs.realpathSync(file))) {
        throw new Error(`Fixture symlink leaves the manuscript: ${file}`);
      }
      return true;
    },
  });
  console.log('Run directory:', run);
  return { run, project };
}

export function stopRunEngine(electronPid, engineUrl) {
  const url = new URL(engineUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('Expected the local engine URL from this Electron session');
  }
  const listener = execFileSync('lsof', ['-nP', '-t', '-a', '-iTCP:' + url.port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
  if (!/^[1-9]\d*$/.test(listener)) throw new Error('Could not uniquely identify the engine listener');
  // TDOM is a direct child of the Electron main process. Other instances may
  // run exactly the same server.js from the same checkout on a different port.
  const owner = execFileSync('ps', ['-p', listener, '-o', 'ppid='], { encoding: 'utf8' });
  if (Number(owner) !== electronPid) throw new Error('The listening process belongs to a different session');
  const pid = Number(listener);
  process.kill(pid, 'SIGTERM');
  return pid;
}
