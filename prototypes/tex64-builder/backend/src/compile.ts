import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docToLatex } from './latex.js';
import { repairLatex } from './ai.js';
import type { DocumentModel } from './types.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUILD_DIR = path.join(ROOT, '.build');
const LAST_GOOD = path.join(BUILD_DIR, 'lastgood.pdf');

function runLatex(cwd: string): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'lualatex',
      ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
      { cwd },
    );
    let log = '';
    proc.stdout.on('data', (d) => (log += d.toString()));
    proc.stderr.on('data', (d) => (log += d.toString()));
    proc.on('close', (code) => resolve({ ok: code === 0, log }));
    proc.on('error', (err) => resolve({ ok: false, log: String(err) }));
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface CompileResult {
  pdf: Buffer;
  stale: boolean;
}

// コンパイルは直列化する(latest-winsのデバウンスはフロント側)
let chain: Promise<unknown> = Promise.resolve();

export function compileDoc(doc: DocumentModel): Promise<CompileResult | null> {
  const job = chain.then(() => doCompile(doc));
  chain = job.catch(() => {});
  return job;
}

async function doCompile(doc: DocumentModel): Promise<CompileResult | null> {
  await mkdir(BUILD_DIR, { recursive: true });
  const { source, figures } = docToLatex(doc);

  for (const fig of figures) {
    await writeFile(path.join(BUILD_DIR, fig.filename), fig.data);
  }
  await writeFile(path.join(BUILD_DIR, 'main.tex'), source, 'utf8');

  let result = await runLatex(BUILD_DIR);

  // AIによる自己修復ループ: 失敗はユーザーに露出させず内部で吸収する
  if (!result.ok) {
    const fixed = await repairLatex(source, result.log.slice(-4000));
    if (fixed) {
      await writeFile(path.join(BUILD_DIR, 'main.tex'), fixed, 'utf8');
      result = await runLatex(BUILD_DIR);
    }
  }

  if (result.ok) {
    const pdfPath = path.join(BUILD_DIR, 'main.pdf');
    await copyFile(pdfPath, LAST_GOOD);
    return { pdf: await readFile(pdfPath), stale: false };
  }

  // 失敗時は直前の正常なPDFを返す(エラーは決して見せない)
  if (await exists(LAST_GOOD)) {
    console.warn('[compile] failed; serving last good PDF');
    return { pdf: await readFile(LAST_GOOD), stale: true };
  }
  console.warn('[compile] failed; no PDF available yet');
  return null;
}
