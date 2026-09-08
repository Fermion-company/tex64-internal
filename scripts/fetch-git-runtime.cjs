#!/usr/bin/env node
'use strict';
// Build-time only: pinned upstream Git + self-contained GCM, never system Git.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const manifest = require('./git-runtime-manifest.json');
const destination = path.join(__dirname, '..', 'Resources', 'git-runtime');
const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
async function download(url, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Missing pinned SHA-256');
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (digest(data) !== expected) throw new Error(`SHA-256 mismatch: ${url}`);
  return data;
}
async function inventory(root, dir = root, rows = []) {
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name), relative = path.relative(root, full);
    if (relative === 'tex64-runtime.json') continue;
    if (entry.isSymbolicLink()) {
      const resolved = await fs.realpath(full);
      if (!resolved.startsWith(root + path.sep)) throw new Error(`Escaping runtime symlink: ${relative}`);
      rows.push([relative, 'link', await fs.readlink(full)]);
    } else if (entry.isDirectory()) await inventory(root, full, rows);
    else if (entry.isFile()) rows.push([relative, (await fs.stat(full)).mode & 0o777, digest(await fs.readFile(full))]);
    else throw new Error(`Unsupported runtime entry: ${relative}`);
  }
  return rows;
}
async function fetchTarget(key) {
  const target = manifest.targets[key];
  if (!target) throw new Error(`Unsupported Git runtime: ${key}`);
  const out = path.join(destination, key);
  try {
    const marker = JSON.parse(await fs.readFile(path.join(out, 'tex64-runtime.json'), 'utf8'));
    if (marker.release === manifest.release && marker.archiveSha256 === target.sha256 &&
        JSON.stringify(marker.files) === JSON.stringify(await inventory(out))) {
      console.log(`[git-runtime] ${key}: verified existing runtime`); return;
    }
    throw new Error(`Existing runtime differs from its manifest: ${out}. Remove this build asset and fetch again.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(destination, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(destination, '.download-'));
  try {
    const archive = path.join(temporary, 'runtime.tar.gz'), extracted = path.join(temporary, 'runtime');
    await fs.writeFile(archive, await download(`https://github.com/${manifest.repository}/releases/download/${manifest.release}/${target.asset}`, target.sha256));
    const names = execFileSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
    if (names.some(name => path.posix.isAbsolute(name) || name.split('/').includes('..'))) throw new Error('Unsafe archive member');
    await fs.mkdir(extracted);
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
    for (const required of ['bin/git', 'libexec/git-core/git-credential-manager', 'libexec/git-core/libhostfxr.dylib', 'libexec/git-core/libcoreclr.dylib']) await fs.access(path.join(extracted, required));
    const files = await inventory(extracted);
    await fs.writeFile(path.join(extracted, 'tex64-runtime.json'), JSON.stringify({ schema: 1, release: manifest.release, gitVersion: manifest.gitVersion, gcmVersion: manifest.gcmVersion, target: key, archiveSha256: target.sha256, files }, null, 2) + '\n');
    // Refuse to overwrite an existing asset; builds must not race running copies.
    try { await fs.lstat(out); throw new Error(`Runtime already exists: ${out}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(extracted, out);
    console.log(`[git-runtime] ${key}: installed verified ${manifest.release}`);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
async function fetchLegal() {
  const out = path.join(destination, 'legal'); await fs.mkdir(out, { recursive: true });
  for (const item of manifest.legal) {
    const filename = path.join(out, item.name);
    try { if (digest(await fs.readFile(filename)) === item.sha256) continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const data = await download(item.url, item.sha256);
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, data); await fs.rename(temporary, filename);
  }
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
async function main(args = process.argv.slice(2)) {
  const keys = args.includes('--mac') ? ['darwin-arm64', 'darwin-x64'] : [`${os.platform()}-${os.arch()}`];
  for (const key of keys) await fetchTarget(key);
  await fetchLegal();
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { manifest, inventory, fetchTarget, fetchLegal, main };
