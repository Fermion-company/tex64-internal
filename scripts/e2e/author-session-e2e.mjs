// Author-session E2E: an "author" jumps around a 316-page real document —
// typing, cutting, copying, pasting across chapters — while the whole window
// is screen-recorded. This driver only OBSERVES and RECORDS; it does not
// diagnose or fix anything. See scripts/e2e/README.md for the sibling
// live-preview driver this one borrows its plumbing from.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { _electron: electron } = require('playwright');

const RUN = process.env.RUN_DIR;
const APP = process.env.APP_DIR || new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ENGINE = process.env.ENGINE_DIR;
const SANDBOX = process.env.SANDBOX || `${process.env.HOME}/Desktop/tex64-validation-20260914/sandbox-copy`;
// sandbox-copy's ch16.tex already carries earlier test markers (aaa/iii/XYZ)
// baked into the fixture; this is the hash the task handoff gave us.
const MAIN_SHA = process.env.MAIN_SHA || 'bd20ea0d36d84cd136f39498e79383a854c44163f34d308f342041e0ca12898e';
const CH16_SHA = process.env.CH16_SHA || 'ccb030fcd7eb4cbcc6683e508a0c9f29193b122c51369777f61e1033dc599960';
const TARGET_PAGE = Number(process.env.TARGET_PAGE || 163);
if (!RUN || !ENGINE) throw new Error('RUN_DIR and ENGINE_DIR are required');

for (const d of ['video', 'shots', 'script', 'project']) fs.mkdirSync(`${RUN}/${d}`, { recursive: true });
const PROJECT = `${RUN}/project`;

// Keep a copy of the script actually used for this run.
try { fs.copyFileSync(new URL(import.meta.url), `${RUN}/script/author-session-e2e.mjs`); } catch {}

// ---------------------------------------------------------------- logging --
let t0 = null; // set the instant recordVideo/launch starts
const actionsFile = `${RUN}/actions.jsonl`;
const mdRows = [];
const fmtSec = (sec) => {
  if (sec == null) return '--:--';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const writeMd = () => {
  const header = [
    '# Author session — action index',
    '',
    'mm:ss は動画開始（Electron 起動 = recordVideo 開始）からの経過時間。',
    '',
  ];
  fs.writeFileSync(`${RUN}/actions.md`, header.concat(mdRows).join('\n') + '\n');
};
const actionLog = (k, detail = {}, extra = {}) => {
  const t = Date.now();
  const videoSec = t0 != null ? (t - t0) / 1000 : null;
  const row = { t, videoSec, k, ...extra, detail };
  fs.appendFileSync(actionsFile, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row).slice(0, 400));
  return row;
};
const mdLine = (line) => { mdRows.push(line); writeMd(); };

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lualatexCount = () => {
  try { return Number(execSync('pgrep -x lualatex | wc -l').toString().trim()) || 0; } catch { return 0; }
};
// Leak guard is relative to whatever lualatex the user's own TeX64.app
// already owns at launch. We only ever touch our own Electron + its engine.
const lualatexBaseline = lualatexCount();
const LUALATEX_LIMIT = lualatexBaseline + Number(process.env.LUALATEX_LEAK_ALLOWANCE || 80);
const guardLualatex = () => {
  if (lualatexCount() > LUALATEX_LIMIT) throw new Error(`lualatex process count exceeded ${LUALATEX_LIMIT} (baseline ${lualatexBaseline})`);
};

// ---- project copy (never touch SANDBOX or testing/sandbox-pro) ----
if (!fs.existsSync(PROJECT) || !fs.existsSync(`${PROJECT}/main.tex`)) {
  execSync(`cp -R ${JSON.stringify(SANDBOX)}/. ${JSON.stringify(PROJECT)}`);
}
const mainSha = sha(fs.readFileSync(`${PROJECT}/main.tex`, 'utf8'));
const ch16Text0 = fs.readFileSync(`${PROJECT}/content/ch16.tex`, 'utf8');
actionLog('project', { PROJECT, mainOk: mainSha === MAIN_SHA, ch16Ok: sha(ch16Text0) === CH16_SHA, lualatexBaseline });
if (mainSha !== MAIN_SHA || sha(ch16Text0) !== CH16_SHA) throw new Error('project copy hash mismatch');

const getJson = (url, timeoutMs = 4000) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
  });
  req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  req.on('error', reject);
});

// ------------------------------------------------------------------ launch --
t0 = Date.now();
fs.writeFileSync(actionsFile, JSON.stringify({ t: t0, videoSec: 0, k: 't0', detail: { note: 'video/app start' } }) + '\n');
const app = await electron.launch({
  cwd: APP,
  args: [APP],
  timeout: 180_000,
  recordVideo: { dir: `${RUN}/video`, size: { width: 1600, height: 1000 } },
  env: {
    ...process.env,
    TEX64_E2E_USERDATA: `${RUN}/profile`,
    TEX64_E2E_FORCE_HEADLESS: '0',
    TEX64_ALLOW_MULTI_INSTANCE: '1',
    TEX64_AI_MODE_ENABLED: '0',
    TDOM_ENGINE_DIR: ENGINE,
    ...(process.env.TDOM_MAX_CHECKPOINTS ? { TDOM_MAX_CHECKPOINTS: process.env.TDOM_MAX_CHECKPOINTS } : {}),
    TDOM_ANCHOR_DIAG: `${RUN}/engine-diag.jsonl`,
    TEX64_LIVEDIAG_FILE: `${RUN}/main-diag.jsonl`,
  },
});
const proc = app.process();
proc.stdout?.on('data', (d) => fs.appendFileSync(`${RUN}/electron-stdout.log`, d));
proc.stderr?.on('data', (d) => fs.appendFileSync(`${RUN}/electron-stderr.log`, d));
let page = await app.firstWindow();
try { await page.setViewportSize({ width: 1600, height: 1000 }); } catch (e) { actionLog('viewport-error', { error: String(e).slice(0, 200) }); }
const attachConsole = (p) => p.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[LIVEDIAG]')) fs.appendFileSync(`${RUN}/renderer-diag.jsonl`, text.slice(11) + '\n');
  else if (msg.type() === 'error' || text.includes('[live-preview]')) fs.appendFileSync(`${RUN}/renderer-console.log`, `${Date.now()} ${msg.type()} ${text}\n`);
});
attachConsole(page);
await page.waitForLoadState('domcontentloaded');
await page.evaluate(() => localStorage.setItem('tex64.editor.feature.preview.realtime', 'true'));
await page.reload();
await page.waitForLoadState('domcontentloaded');
await sleep(2500);
let videoPathNoted = null;
try { videoPathNoted = await page.video()?.path(); } catch {}
actionLog('launched', { title: await page.title(), video: videoPathNoted });
if (!videoPathNoted) actionLog('video-warning', { note: 'page.video() returned no path; recordVideo may not be active' });

await page.evaluate((p) => window.tex64Bridge.postMessage({ type: 'openRecentProject', path: p }), PROJECT);
await page.waitForSelector('button.file-item[data-path="main.tex"]', { timeout: 120_000, state: 'attached' });
actionLog('workspace-open');

// ---- engine readiness + status/SSE recorders -------------------------------
let engineUrl = null;
const engineStatus = async () => {
  if (!engineUrl) {
    const st = await page.evaluate(() => window.tex64Tdom?.status?.()).catch(() => null);
    engineUrl = st?.url || null;
    if (!engineUrl) return null;
  }
  return getJson(`${engineUrl}/status`).catch(() => null);
};
const compact = (s) => s && ({
  srcRev: s.srcRev, busy: s.busy, documentEpoch: s.documentEpoch,
  canonical: s.canonical && { id: s.canonical.id, rev: s.canonical.rev, pageCount: s.canonical.pageCount,
    runningRev: s.canonical.runningRev, scheduledRev: s.canonical.scheduledRev, inFlight: s.canonical.inFlight },
  queue: s.queue ?? s.queueLength ?? null, warm: s.warm ?? null,
});
// The task wants an engine-status.jsonl with srcRev/canonical/cold/progress/warm/render.
const compactEngine = (s) => s && ({
  srcRev: s.srcRev, busy: s.busy, mode: s.mode,
  canonical: s.canonical && { id: s.canonical.id, rev: s.canonical.rev, pageCount: s.canonical.pageCount,
    runningRev: s.canonical.runningRev, scheduledRev: s.canonical.scheduledRev, inFlight: s.canonical.inFlight,
    error: s.canonical.error ?? null },
  cold: s.cold ? { pending: Array.isArray(s.cold.pending) ? s.cold.pending.length : s.cold.pending,
    walkPhase: s.cold.walk?.phase ?? null } : null,
  progress: s.progress ?? null,
  warm: s.warm ? { status: s.warm.status, sourceRev: s.warm.sourceRev } : null,
  render: s.render ? { queued: s.render.queued?.length ?? s.render.queued, active: s.render.active,
    pumping: s.render.pumping } : null,
});
let statusTimer = null;
const startStatusPoll = () => {
  const tick = async () => {
    try {
      const s = await engineStatus();
      if (!s) return;
      const t = Date.now();
      fs.appendFileSync(`${RUN}/engine-status.jsonl`, JSON.stringify({ t, videoSec: (t - t0) / 1000, ...compactEngine(s) }) + '\n');
    } catch {}
  };
  tick();
  statusTimer = setInterval(tick, 2000);
};
const waitCanonical = async (label, limitMs) => {
  const deadline = Date.now() + limitMs;
  let last = null;
  while (Date.now() < deadline) {
    const s = await engineStatus();
    const c = compact(s);
    if (JSON.stringify(c) !== JSON.stringify(last)) { actionLog(`${label}:status`, { status: c, lualatex: lualatexCount() }); last = c; }
    guardLualatex();
    if (s && s.canonical && s.canonical.rev === s.srcRev && s.canonical.pageCount >= 300 && !s.busy &&
        !s.canonical.inFlight && s.canonical.runningRev == null) return s;
    await sleep(2000);
  }
  throw new Error(`${label}: canonical did not converge`);
};
await waitCanonical('open', 15 * 60_000);
startStatusPoll();

const sse = fs.createWriteStream(`${RUN}/sse.jsonl`, { flags: 'a' });
const startSse = () => {
  const req = http.get(`${engineUrl}/events`, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let m; try { m = JSON.parse(line.slice(6)); } catch { continue; }
        const r = m.report;
        sse.write(JSON.stringify({
          at: Date.now(), videoSec: (Date.now() - t0) / 1000, kind: m.kind, documentEpoch: m.documentEpoch,
          srcRev: r?.srcRev, rev: r?.rev ?? m.rev,
          stats: r?.stats && { totalUs: r.stats.totalUs, typesetMs: r.stats.typesetMs, rebooted: r.stats.rebooted ?? r.rebooted,
            blocksTypeset: r.stats.blocksTypeset, pagesReused: r.stats.pagesReused, pagesRebuilt: r.stats.pagesRebuilt,
            pageCount: r.stats.pageCount, chainVerdict: r.stats.chainVerdict, coldPending: r.stats.coldPending,
            diagnostics: r.stats.diagnostics?.slice?.(0, 12) },
          edit: r?.edit,
          patches: r?.patches?.map((p) => ({ type: p.type, page: p.page })),
          previewFallback: r?.previewFallback, canonicalAnchor: r?.canonicalAnchor ?? undefined,
          anchorRefused: r?.canonicalAnchorRefused ?? undefined,
          canonical: m.canonical && { id: m.canonical.id, rev: m.canonical.rev, pageCount: m.canonical.pageCount },
          anchorPatch: m.kind === 'canonical-anchor' ? { status: m.patch?.status, reason: m.patch?.reason, srcRev: m.patch?.srcRev,
            proofMs: m.patch?.proofMs, pages: m.patch?.pages?.map?.((p) => p.page ?? p) } : undefined,
          reason: m.reason,
        }) + '\n');
      }
    });
  });
  req.on('error', (e) => actionLog('sse-error', { error: String(e) }));
  return req;
};
let sseReq = startSse();

// ---- frame / pdf / groups helpers (same shape as live-preview-e2e.mjs) ----
const pdfFrame = () => page.frames().find((f) => f.url().includes('pdf-viewer.html'));
const pdfState = async () => {
  const f = pdfFrame();
  if (!f) return null;
  return f.evaluate(() => {
    const frame = document.getElementById('pdf-live-frame');
    const v = window.__tex64PdfViewer;
    return {
      body: document.body.className,
      staticPage: v?.pdfViewer?.currentPageNumber ?? null,
      staticPages: v?.state?.doc?.numPages ?? null,
      pageInput: document.getElementById('pdf-page-input')?.value ?? null,
      pageCount: document.getElementById('pdf-page-count')?.textContent ?? null,
      status: document.getElementById('pdf-status')?.textContent ?? document.querySelector('.pdf-status')?.textContent ?? null,
      livePhase: frame?.dataset?.livePhase ?? null,
      liveSrc: frame?.getAttribute('src')?.replace(/bg=[^&]*/, '') ?? null,
    };
  }).catch((e) => ({ error: String(e).slice(0, 200) }));
};
const groupsState = () => page.evaluate(() => ({
  primary: [...document.querySelectorAll('.editor-group[data-editor-group="primary"] .editor-tab')].map((x) => ({ path: x.dataset.path, active: x.classList.contains('is-active') })),
  secondary: [...document.querySelectorAll('.editor-group[data-editor-group="secondary"] .editor-tab')].map((x) => ({ path: x.dataset.path, active: x.classList.contains('is-active') })),
  pdfs: [...document.querySelectorAll('button.file-item')].map((b) => b.dataset.path).filter((p) => p?.endsWith('.pdf')),
}));
const shot = async (name) => {
  try { await page.screenshot({ path: `${RUN}/shots/${name}.png` }); } catch (e) { actionLog('shot-error', { name, error: String(e).slice(0, 200) }); }
};

// ---- dismiss Settings / announcement dialogs -------------------------------
const dismissSettings = async () => {
  const open = await page.evaluate(() => document.getElementById('settings-pages')?.getAttribute('aria-hidden') === 'false');
  if (!open) return;
  await page.click('#settings-close').catch((e) => actionLog('settings-close-error', { error: String(e).slice(0, 200) }));
  await sleep(800);
};
await dismissSettings();
for (let i = 0; i < 3; i += 1) {
  const open = await page.evaluate(() => document.getElementById('announcement-modal')?.classList.contains('is-open'));
  if (!open) break;
  await page.click('#announcement-modal-close').catch((e) => actionLog('announcement-close-error', { error: String(e).slice(0, 200) }));
  await sleep(800);
}

// ---- Build ------------------------------------------------------------------
{
  const pdfPath = `${PROJECT}/main.pdf`;
  const mtime = () => (fs.existsSync(pdfPath) ? fs.statSync(pdfPath).mtimeMs : 0);
  const before = mtime();
  await page.click('#build-button');
  actionLog('build-click');
  const deadline = Date.now() + Number(process.env.BUILD_WAIT_MS || 20 * 60_000);
  let built = false;
  while (Date.now() < deadline) {
    const rows = fs.existsSync(`${RUN}/renderer-diag.jsonl`) ? fs.readFileSync(`${RUN}/renderer-diag.jsonl`, 'utf8') : '';
    if (rows.includes('"clp:build-success"') || mtime() > before) { built = true; break; }
    guardLualatex();
    await sleep(1000);
  }
  if (!built) throw new Error('build did not succeed in time');
  actionLog('build-success', { pdfMtime: mtime() });
}
let pdfLoaded = false;
for (let i = 0; i < 90 && !pdfLoaded; i += 1) {
  const s = await pdfState();
  if (s?.staticPages >= 300) { actionLog('pdf-loaded', { pdf: s }); pdfLoaded = true; break; }
  if (i === 10 && !pdfFrame()) {
    await shot('build-no-pdf');
    actionLog('no-pdf-frame', { groups: await groupsState() });
    await page.evaluate(() => window.tex64Bridge.postMessage({ type: 'openFile', path: 'main.pdf' }));
    actionLog('open-main-pdf');
  }
  await sleep(1000);
}
if (!pdfLoaded) {
  await shot('pdf-missing');
  actionLog('pdf-missing', { groups: await groupsState(), pdf: await pdfState() });
  throw new Error('PDF viewer did not load main.pdf');
}
await sleep(3000);
await waitCanonical('post-build', 10 * 60_000);

// ---- pdf page navigation helpers --------------------------------------------
const CHAPTER_PAGE = { 'content/ch16.tex': 163, 'content/ch29.tex': 299 };
const approxPageFor = (relPath) => {
  if (CHAPTER_PAGE[relPath]) return CHAPTER_PAGE[relPath];
  const m = relPath.match(/ch(\d+)\.tex$/);
  if (!m) return TARGET_PAGE;
  return Math.max(1, Math.round(Number(m[1]) * 10.5));
};
const setPdfPageDirect = async (n) => {
  await pdfFrame()?.evaluate((n) => { if (window.__tex64PdfViewer?.pdfViewer) window.__tex64PdfViewer.pdfViewer.currentPageNumber = n; }, n).catch(() => {});
  await pdfFrame()?.evaluate((n) => {
    const input = document.getElementById('pdf-page-input');
    if (!input) return;
    input.value = String(n);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, n).catch(() => {});
};
// Try SyncTeX forward ("Jump") first, then fall back to a direct/approximate
// page (chapter number * ~10.5 pages) as the task's script instructs.
const gotoPdfPage = async (relPath, { useJump = true, settleMs = 1500 } = {}) => {
  const target = approxPageFor(relPath);
  if (useJump) {
    const enabled = await page.evaluate(() => {
      const b = document.getElementById('synctex-button');
      return !!b && !b.disabled;
    }).catch(() => false);
    if (enabled) {
      await page.click('#synctex-button').catch(() => {});
      await sleep(1800);
    }
  }
  const s = await pdfState();
  const got = s?.staticPage ?? null;
  if (got == null || Math.abs(got - target) > 20) {
    await setPdfPageDirect(target);
    await sleep(settleMs);
  }
  const result = { target, pdf: await pdfState() };
  actionLog('pdf-goto', result, { file: relPath });
  return result;
};
// Fast variant for the tight-dwell round trip (step 8): no Jump, no long settle.
const gotoPdfPageFast = async (relPath) => {
  const target = approxPageFor(relPath);
  await setPdfPageDirect(target);
  actionLog('pdf-goto-fast', { target }, { file: relPath });
  return target;
};

await setPdfPageDirect(TARGET_PAGE);
await sleep(1500);
if (/\bis-live\b/.test((await pdfState())?.body ?? '') && !/is-live-held/.test((await pdfState())?.body ?? '')) {
  await setPdfPageDirect(TARGET_PAGE);
  await sleep(2500);
}
actionLog('pdf-positioned', { pdf: await pdfState() });

// ---- open ch16 in the primary group via the file tree ----------------------
const openFileInPrimary = async (relPath) => {
  await page.evaluate(() => {
    const tab = document.querySelector('.editor-group[data-editor-group="primary"] .editor-tab.is-active') ||
      document.querySelector('.editor-group[data-editor-group="primary"] .editor-tab');
    tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tab?.click();
  });
  await sleep(400);
  await page.evaluate((p) => document.querySelector(`button.file-item[data-path="${p}"]`)?.click(), relPath);
  await sleep(1200);
};
await openFileInPrimary('content/ch16.tex');
actionLog('layout', await groupsState());

// ---- Monaco caret / editor helpers (Monaco API only to LOCATE, never to
// mutate content or set a non-collapsed selection — actual selection/cut/
// copy/paste always goes through page.keyboard, per the task's script).
const findEditorInfo = async (relPath) => page.evaluate((f) => {
  const editors = window.monaco?.editor?.getEditors?.() ?? [];
  const ed = editors.find((e) => e.getModel()?.uri?.path?.endsWith('/' + f));
  if (!ed) return { ok: false, uris: editors.map((e) => e.getModel()?.uri?.path) };
  window.__e2eEditor = ed;
  return { ok: true, text: ed.getValue() };
}, relPath);
const setCaret = async (relPath, line, column) => page.evaluate(({ f, line, column }) => {
  const editors = window.monaco?.editor?.getEditors?.() ?? [];
  const ed = editors.find((e) => e.getModel()?.uri?.path?.endsWith('/' + f));
  if (!ed) return { ok: false };
  ed.setPosition({ lineNumber: line, column });
  ed.setSelection({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column });
  ed.revealLineInCenter(line);
  ed.focus();
  window.__e2eEditor = ed;
  return { ok: true };
}, { f: relPath, line, column });
const currentValue = async () => page.evaluate(() => window.__e2eEditor?.getValue() ?? null);

// Verify ch16 still matches the known fixture before we start editing it.
{
  const info = await findEditorInfo('content/ch16.tex');
  if (!info.ok) throw new Error(`ch16 editor not found: ${JSON.stringify(info)}`);
  if (sha(info.text) !== CH16_SHA) throw new Error('ch16 model differs from the original at start');
}

// ---- step scaffolding: pre-shot, run, post-shots at +0/+0.5/+2/+5s ---------
const preShot = async (id) => { await shot(`${id}-pre`); actionLog('shot', {}, { id, phase: 'pre' }); };
const postShots = async (id) => {
  await shot(`${id}-post-000`); actionLog('shot', {}, { id, phase: 'post+0.0s' });
  await sleep(500);
  await shot(`${id}-post-050`); actionLog('shot', {}, { id, phase: 'post+0.5s' });
  await sleep(1500);
  await shot(`${id}-post-200`); actionLog('shot', {}, { id, phase: 'post+2.0s' });
  await sleep(3000);
  await shot(`${id}-post-500`); actionLog('shot', {}, { id, phase: 'post+5.0s' });
};
const runStep = async (id, meta, fn) => {
  const { title, file, line, expect } = meta;
  await preShot(id);
  const startRow = actionLog('step-start', { title, expect }, { id, file, line });
  let result;
  let error = null;
  try { result = await fn(); } catch (e) { error = String(e).slice(0, 400); }
  const endRow = actionLog('step-end', { title, result, error }, { id, file, line });
  await postShots(id);
  mdLine(`\n### ${id}  ${fmtSec(startRow.videoSec)} 〜 ${fmtSec(endRow.videoSec)}`);
  mdLine(`- 何を: ${title}`);
  if (file) mdLine(`- どこ: ${file}${line ? `:${line}` : ''}`);
  if (expect) mdLine(`- 期待される見え方: ${expect}`);
  if (error) mdLine(`- **エラー**: ${error}`);
  if (result) mdLine(`- 記録: \`${JSON.stringify(result).slice(0, 300)}\``);
  if (error) throw new Error(`step ${id} failed: ${error}`);
  return result;
};

// Build 完了後、背景の checkpoint 整備が終わるまで 60 秒待ってから台本を開始
// する（著者は待たないので、これは台本の一部ではなく前提の続き）。
{
  const soakStart = actionLog('post-build-soak-start');
  await shot('00-post-build-soak');
  await sleep(60_000);
  const soakEnd = actionLog('post-build-soak-end', { status: compact(await engineStatus()) });
  mdLine(`\n### 00  ${fmtSec(soakStart.videoSec)} 〜 ${fmtSec(soakEnd.videoSec)}`);
  mdLine('- 何を: Build完了後、checkpoint整備のため60秒待機（台本の前提）');
}

// ============================================================================
// The author-session script (task steps 1..11)
// ============================================================================
const PLAIN_PARA_LINES = [11, 33, 54, 77, 102, 125, 148, 170, 185, 201];
const STEP1_SENTENCE = 'この観点は次章の演習でも繰り返し使うので、ここで手順を言葉にしておく。';

// -- 1: ch16.tex:33 "iii" の直後に一文を80-120ms/字で入力 --------------------
await runStep('01', {
  title: 'ch16.tex 33行目「iii」の直後に日本語の一文を1字80〜120msで入力',
  file: 'content/ch16.tex', line: 33,
  expect: '163ページの当該行に新しい一文が現れる',
}, async () => {
  await gotoPdfPage('content/ch16.tex');
  const info = await findEditorInfo('content/ch16.tex');
  const lineText = info.text.split(/\r?\n/)[32];
  const idx = lineText.indexOf('iii');
  if (idx < 0) throw new Error(`ch16:33 has no "iii" (line=${lineText})`);
  await setCaret('content/ch16.tex', 33, idx + 4);
  for (const ch of STEP1_SENTENCE) {
    await page.keyboard.type(ch);
    await sleep(80 + Math.round(Math.random() * 40));
  }
  const after = await currentValue();
  return { lineAfter: after.split(/\r?\n/)[32] };
});

// -- 2: 3秒以内にch29.tex:171を開き、待たずに「（要確認）」を打つ -----------
await runStep('02', {
  title: 'ch29.tex 171行目末尾の「。」の前に、待たず「（要確認）」を入力',
  file: 'content/ch29.tex', line: 171,
  expect: '299ページの当該行に「（要確認）」が挿入される（warm 待ちなしの cold keystroke）',
}, async () => {
  await openFileInPrimary('content/ch29.tex');
  await gotoPdfPage('content/ch29.tex');
  const info = await findEditorInfo('content/ch29.tex');
  const lineText = info.text.split(/\r?\n/)[170];
  const stop = lineText.lastIndexOf('。');
  if (stop < 0) throw new Error(`ch29:171 has no 。 (line=${lineText})`);
  await setCaret('content/ch29.tex', 171, stop + 1);
  await page.keyboard.type('（要確認）');
  const after = await currentValue();
  return { lineAfter: after.split(/\r?\n/)[170] };
});

// -- 3: ch03.tex 段落をカットして2つ後の段落の後ろに貼り付け ------------------
await runStep('03', {
  title: 'ch03.tex 平文段落(11行目)をCmd+Xでカットし、2つ後の段落の後ろにCmd+Vで貼り付け',
  file: 'content/ch03.tex', line: 11,
  expect: '当該ページ以降の段落順序が入れ替わる',
}, async () => {
  await openFileInPrimary('content/ch03.tex');
  await gotoPdfPage('content/ch03.tex');
  const info = await findEditorInfo('content/ch03.tex');
  const lines = info.text.split(/\r?\n/);
  const srcLine = 11;
  const srcIdx = PLAIN_PARA_LINES.indexOf(srcLine);
  const targetOriginalLine = PLAIN_PARA_LINES[srcIdx + 2];
  const targetText = lines[targetOriginalLine - 1];
  await setCaret('content/ch03.tex', srcLine, 1);
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Meta+x');
  await sleep(300);
  const afterCut = await currentValue();
  const afterLines = afterCut.split(/\r?\n/);
  const newTargetLineNum = afterLines.indexOf(targetText) + 1;
  if (newTargetLineNum <= 0) throw new Error('ch03 target paragraph not found after cut');
  await setCaret('content/ch03.tex', newTargetLineNum + 1, 1);
  await page.keyboard.press('Meta+v');
  const finalText = await currentValue();
  return { targetOriginalLine, newTargetLineNum, finalLineCount: finalText.split(/\r?\n/).length };
});

// -- 4: ch22.tex KKfbox1ブロック+隣接段落をコピーし章末近くへ貼り付け --------
await runStep('04', {
  title: 'ch22.tex KKfbox1ブロック(7-11行目)をCmd+Cでコピーし、章末の最後のクリアページ直前にCmd+Vで貼り付け',
  file: 'content/ch22.tex', line: 7,
  expect: '章末近くに演習ブロックが重複して現れる（大量貼り付け）',
}, async () => {
  await openFileInPrimary('content/ch22.tex');
  await gotoPdfPage('content/ch22.tex');
  const info = await findEditorInfo('content/ch22.tex');
  const lines = info.text.split(/\r?\n/);
  const startLine = 7; // \begin{KKfbox1}
  const blockLines = 5; // through line 11 (plain paragraph) inclusive
  await setCaret('content/ch22.tex', startLine, 1);
  await page.keyboard.press('Home');
  for (let i = 0; i < blockLines; i += 1) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Meta+c');
  await sleep(300);
  const clearpageLines = lines.map((l, i) => (l.trim() === '\\clearpage' ? i + 1 : -1)).filter((n) => n > 0);
  const lastClearpage = clearpageLines[clearpageLines.length - 1];
  await setCaret('content/ch22.tex', lastClearpage, 1);
  await page.keyboard.press('Meta+v');
  const finalText = await currentValue();
  return { lastClearpage, finalLineCount: finalText.split(/\r?\n/).length };
});

// -- 5: ch10.tex 段落末尾に200字程度を30ms/字で連打 ---------------------------
await runStep('05', {
  title: 'ch10.tex 平文段落(11行目)の末尾に約200字の日本語を1字30msで連打',
  file: 'content/ch10.tex', line: 11,
  expect: '当該段落が大きく伸びる（高速バースト入力）',
}, async () => {
  await openFileInPrimary('content/ch10.tex');
  await gotoPdfPage('content/ch10.tex');
  const info = await findEditorInfo('content/ch10.tex');
  const lineText = info.text.split(/\r?\n/)[10];
  await setCaret('content/ch10.tex', 11, lineText.length + 1);
  const burstSource = 'このように、複数の資料を横断して条件を照合し、根拠を一文ずつ対応させながら結論に至る過程を丁寧に言葉にすることが、読み手に伝わる説明にはとても重要である。判断の理由を書くときは、前提と結論の間を一段ずつ埋めるように意識すると、読み返したときの分かりやすさが大きく変わってくるはずである。さらに具体例を一つ添えると説得力が増す。';
  const burst = burstSource.slice(0, 200);
  for (const ch of burst) {
    await page.keyboard.type(ch);
    await sleep(30);
  }
  const after = await currentValue();
  return { lineAfter: after.split(/\r?\n/)[10], typedLength: burst.length };
});

// -- 6: ch16.tex 33+2=35行目を1行まるごと選択してBackspace -------------------
await runStep('06', {
  title: 'ch16.tex 35行目（33行目の2行下）を1行まるごと選択してBackspaceで削除',
  file: 'content/ch16.tex', line: 35,
  expect: '163ページ付近から当該行の文が消える',
}, async () => {
  await openFileInPrimary('content/ch16.tex');
  await gotoPdfPage('content/ch16.tex');
  const before = await findEditorInfo('content/ch16.tex');
  await setCaret('content/ch16.tex', 35, 1);
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Backspace');
  const after = await currentValue();
  return { lineBefore: before.text.split(/\r?\n/)[34], lineNowAt35: after.split(/\r?\n/)[34] };
});

// -- 7: Cmd+Z を3回 ------------------------------------------------------------
await runStep('07', {
  title: 'Cmd+Zを3回（35行目削除の取り消しと、その前の操作の一部取り消し）',
  file: 'content/ch16.tex', line: 35,
  expect: '削除された行が復活し、33行目の内容も一部巻き戻る可能性がある',
}, async () => {
  for (let i = 0; i < 3; i += 1) { await page.keyboard.press('Meta+z'); await sleep(400); }
  const after = await currentValue();
  return { line33: after.split(/\r?\n/)[32], line35: after.split(/\r?\n/)[34] };
});

// -- 8: ch05→ch18→ch27 を往復、各ファイル2秒だけ滞在 --------------------------
await runStep('08', {
  title: 'ch05.tex→ch18.tex→ch27.texの順に開き、各ファイル2秒だけ滞在して行末に1文字「X」を入力',
  file: 'content/ch05.tex, content/ch18.tex, content/ch27.tex', line: 11,
  expect: '3ファイルそれぞれの11行目末尾（「。」の前）に X が入る。PDFは各章のおおよそのページに動く',
}, async () => {
  const files = ['content/ch05.tex', 'content/ch18.tex', 'content/ch27.tex'];
  const results = [];
  for (const f of files) {
    const startedAt = Date.now();
    await openFileInPrimary(f);
    await gotoPdfPageFast(f);
    const info = await findEditorInfo(f);
    const lineText = info.text.split(/\r?\n/)[10];
    const stop = lineText.lastIndexOf('。');
    const col = stop >= 0 ? stop + 1 : lineText.length + 1;
    await setCaret(f, 11, col);
    await page.keyboard.type('X');
    const after = await currentValue();
    results.push({ file: f, lineAfter: after.split(/\r?\n/)[10] });
    actionLog('roundtrip-file', { file: f, lineAfter: after.split(/\r?\n/)[10] });
    const elapsed = Date.now() - startedAt;
    if (elapsed < 2000) await sleep(2000 - elapsed);
  }
  return { results };
});

// -- 9: 30秒何もせず待つ --------------------------------------------------------
await runStep('09', {
  title: '30秒何もせず待つ（canonicalの到着と表示の置き換えを観察）',
  file: null, line: null,
  expect: 'PDFが最新のcanonicalへ静かに置き換わる（はず）',
}, async () => {
  await sleep(Number(process.env.IDLE9_WAIT_MS || 30_000));
  return { status: compact(await engineStatus()) };
});

// -- 10: ch16.tex 33行目、1で打った一文をShift+矢印で選択しCmd+Xで切り取り、
//        5秒待ってからCmd+Vで同じ場所に戻す ------------------------------------
await runStep('10', {
  title: 'ch16.tex 33行目: 手順1で打った一文をShift+矢印で選択しCmd+Xで切り取り、5秒待ってCmd+Vで同じ場所に戻す',
  file: 'content/ch16.tex', line: 33,
  expect: '一瞬文が消え、5秒後に同じ位置へ戻る',
}, async () => {
  await openFileInPrimary('content/ch16.tex');
  await gotoPdfPage('content/ch16.tex');
  const info = await findEditorInfo('content/ch16.tex');
  const lineText = info.text.split(/\r?\n/)[32];
  // Step 7's 3x Cmd+Z may have fully reverted step 1's insertion (Monaco can
  // coalesce a whole typed sentence into one undo unit, not per-keystroke) —
  // this driver only observes/records, so fall back to a marker that is
  // still guaranteed present ("iii") rather than crashing the session.
  let target = STEP1_SENTENCE;
  let idx = lineText.indexOf(target);
  let usedFallback = false;
  if (idx < 0) {
    usedFallback = true;
    target = 'iii';
    idx = lineText.indexOf(target);
    actionLog('step10-fallback', { reason: 'step1 sentence not present on ch16:33 (likely fully undone by step 7)', lineText, fallback: target });
    if (idx < 0) throw new Error(`neither step1 sentence nor fallback marker "iii" found on ch16:33 (line=${lineText})`);
  }
  await setCaret('content/ch16.tex', 33, idx + 1);
  for (let i = 0; i < target.length; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Meta+x');
  const mid = await currentValue();
  await sleep(5000);
  await page.keyboard.press('Meta+v');
  const after = await currentValue();
  return { usedFallback, target, lineDuringCut: mid.split(/\r?\n/)[32], lineAfterPaste: after.split(/\r?\n/)[32] };
});

// -- 11: 60秒何もせず待つ。最後にスクリーンショットと/statusを記録 -------------
await runStep('11', {
  title: '60秒何もせず待つ',
  file: null, line: null,
  expect: '静かなまま安定表示になる（はず）',
}, async () => {
  // FINAL_WAIT_MS lets a stale canonical base land on camera (docs/08 §8.2c):
  // a shot every 60 s marks when the paper changes.
  const total = Number(process.env.FINAL_WAIT_MS || 60_000);
  const started = Date.now();
  let n = 0;
  while (Date.now() - started < total) {
    await sleep(Math.min(60_000, total - (Date.now() - started)));
    n += 1;
    await shot(`11-idle-${String(n).padStart(2, '0')}`);
    actionLog('idle-sample', { pdf: await pdfState(), status: compact(await engineStatus()) });
  }
  return { status: compact(await engineStatus()) };
});

await shot('99-final');
const finalStatus = compact(await engineStatus());
const finalRow = actionLog('final', { pdf: await pdfState(), status: finalStatus,
  ch16Disk: fs.readFileSync(`${PROJECT}/content/ch16.tex`, 'utf8').split(/\r?\n/)[32] });
mdLine(`\n### 99-final  ${fmtSec(finalRow.videoSec)}`);
mdLine('- 何を: 最終スクリーンショットと /status の記録');

// ---- teardown ----------------------------------------------------------------
if (statusTimer) clearInterval(statusTimer);
sseReq.destroy();
let videoPath = null;
try { videoPath = await page.video()?.path(); } catch {}
const totalSec = (Date.now() - t0) / 1000;
await app.close();
actionLog('closed', { videoPath, totalSec });

// ---- README.md -----------------------------------------------------------
let engineCommit = 'unknown';
try { engineCommit = execSync(`git -C ${JSON.stringify(ENGINE)} rev-parse HEAD`).toString().trim(); } catch {}
const readme = `# TeX64 Pro — author-session E2E (${new Date(t0).toISOString()})

## 実行コマンド

\`\`\`
RUN_DIR=${RUN} ENGINE_DIR=${ENGINE} SANDBOX=${SANDBOX} node scripts/e2e/author-session-e2e.mjs
\`\`\`

## 環境

- engine commit: ${engineCommit}
- checkpoint 上限: 既定（TDOM_MAX_CHECKPOINTS 未指定。このMacでは既定 12）
- lualatex baseline（起動前から動いていた数）: ${lualatexBaseline}
- lualatex 上限（ガード）: baseline + ${process.env.LUALATEX_LEAK_ALLOWANCE || 80}
- video: ${videoPath || '(記録なし: video-warning を参照)'}
- 総所要時間（起動〜app.close）: 約 ${Math.round(totalSec)} 秒

## 動画の見方

- 動画は Electron 起動（recordVideo 開始）を 00:00 として、そのまま app.close() まで一続きで録画。
- \`actions.md\` に各操作（01〜11）の mm:ss 区間・対象ファイル・行・期待される見え方を記載。
- \`actions.jsonl\` に同じ内容を機械可読で記録（t=epoch ms, videoSec=動画開始からの秒）。
- \`engine-status.jsonl\` に2秒ごとの /status スナップショット（srcRev, canonical, cold, progress, warm, render）。
- \`sse.jsonl\` にエンジンの SSE イベント（report / canonical-anchor 等）。
- \`shots/\` に各操作の直前(-pre)・直後(+0/+0.5/+2/+5s)のスクリーンショット。

## 台本

1. ch16.tex:33 "iii" の直後に一文を80-120ms/字で入力
2. 3秒以内にch29.tex:171を開き、待たずに「（要確認）」を入力
3. ch03.tex: 段落をカットして2つ後の段落の後ろに貼り付け
4. ch22.tex: KKfbox1ブロックを含む段落をコピーし章末近くに貼り付け
5. ch10.tex: 段落末尾に約200字を30ms/字で連打
6. ch16.tex: 33行目の2行下(35行目)を1行削除
7. Cmd+Zを3回
8. ch05→ch18→ch27 を往復、各2秒滞在で1文字入力
9. 30秒待機
10. ch16.tex:33 手順1の一文をCmd+Xで切って5秒後にCmd+Vで戻す
11. 60秒待機、最終記録

## 既知の注意点

- /Applications/TeX64.app とそのプロセス・lualatex には一切触れていない（このドライバは自分のElectronとその子だけを扱う）。
- 原本 testing/sandbox-pro と sandbox-copy は書き換えていない（実操作は RUN_DIR/project の複製に対してのみ）。
- エディタの選択・カット・コピー・ペーストは page.keyboard（Home/Shift+ArrowDown/Shift+ArrowRight/Meta+X/C/V/Z）で行った。Monaco API はキャレット位置の設定と行の特定にのみ使用し、内容の直接書き換えや非collapsedな selection の直接設定は行っていない。
- PDF位置合わせは SyncTeX の #synctex-button（Jump）を優先し、動かない/大きくずれる場合は章番号×約10.5ページの概算、または ch16/ch29 の既知ページ（163/299）で直接ページ送りにフォールバックした。
`;
fs.writeFileSync(`${RUN}/README.md`, readme);
console.log('DONE', JSON.stringify({ videoPath, totalSec }));
