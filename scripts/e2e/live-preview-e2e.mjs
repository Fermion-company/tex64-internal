// Real-app E2E for the Build → live preview handoff and canonical-anchor.
// Drives the Electron app with Playwright against a copy of the 316-page
// sandbox project. See README.md in this directory for scenarios and the
// expected results. Only one engine may run at a time: quit TeX64 first.
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
const SANDBOX = process.env.SANDBOX || `${process.env.HOME}/Desktop/tex64-pro-sandbox`;
// The fixture the measurements in README.md were taken on.
const MAIN_SHA = process.env.MAIN_SHA || 'bd20ea0d36d84cd136f39498e79383a854c44163f34d308f342041e0ca12898e';
const CH16_SHA = process.env.CH16_SHA || '6b188b8ee4b03eb0f5675269567263851cc4cc635d82baba8decbaa44247d341';
const TARGET_PAGE = Number(process.env.TARGET_PAGE || 163);
const SKIP_BUILD = process.env.SKIP_BUILD === '1';
if (!RUN || !ENGINE) throw new Error('RUN_DIR and ENGINE_DIR are required');
fs.mkdirSync(`${RUN}/shots`, { recursive: true });
const PROJECT = `${RUN}/project`;
const logFile = `${RUN}/driver.jsonl`;
const log = (k, v = {}) => {
  const row = { t: Date.now(), k, ...v };
  fs.appendFileSync(logFile, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row).slice(0, 400));
};
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lualatexCount = () => {
  try { return Number(execSync("pgrep -x lualatex | wc -l").toString().trim()) || 0; } catch { return 0; }
};
// Leak guard: the limit is relative to whatever lualatex processes another
// TeX64 (e.g. the user's own app with a live engine) already owns at launch.
const lualatexBaseline = lualatexCount();
const LUALATEX_LIMIT = lualatexBaseline + Number(process.env.LUALATEX_LEAK_ALLOWANCE || 80);
const guardLualatex = () => {
  if (lualatexCount() > LUALATEX_LIMIT) throw new Error(`lualatex process count exceeded ${LUALATEX_LIMIT} (baseline ${lualatexBaseline})`);
};

// ---- project copy
if (!fs.existsSync(PROJECT)) {
  execSync(`cp -R ${JSON.stringify(SANDBOX)} ${JSON.stringify(PROJECT)}`);
}
const mainSha = sha(fs.readFileSync(`${PROJECT}/main.tex`, 'utf8'));
const ch16Text = fs.readFileSync(`${PROJECT}/content/ch16.tex`, 'utf8');
log('project', { PROJECT, mainOk: mainSha === MAIN_SHA, ch16Ok: sha(ch16Text) === CH16_SHA, lualatexBaseline });
if (mainSha !== MAIN_SHA || sha(ch16Text) !== CH16_SHA) throw new Error('project copy hash mismatch');

const getJson = (url, timeoutMs = 4000) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
  });
  req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  req.on('error', reject);
});

// ---- launch
const app = await electron.launch({
  cwd: APP,
  args: [APP],
  timeout: 180_000,
  env: {
    ...process.env,
    TEX64_E2E_USERDATA: `${RUN}/profile`,
    TEX64_E2E_FORCE_HEADLESS: '0',
    TEX64_ALLOW_MULTI_INSTANCE: '1',
    TEX64_AI_MODE_ENABLED: '0',
    TDOM_ENGINE_DIR: ENGINE,
    TDOM_MAX_CHECKPOINTS: '8',
    TDOM_ANCHOR_DIAG: `${RUN}/engine-diag.jsonl`,
    TEX64_LIVEDIAG_FILE: `${RUN}/main-diag.jsonl`,
  },
});
const proc = app.process();
proc.stdout?.on('data', (d) => fs.appendFileSync(`${RUN}/electron-stdout.log`, d));
proc.stderr?.on('data', (d) => fs.appendFileSync(`${RUN}/electron-stderr.log`, d));
let page = await app.firstWindow();
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
log('launched', { title: await page.title() });

await page.evaluate((p) => window.tex64Bridge.postMessage({ type: 'openRecentProject', path: p }), PROJECT);
await page.waitForSelector('button.file-item[data-path="main.tex"]', { timeout: 120_000, state: 'attached' });
log('workspace-open');

// ---- engine readiness
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
  srcRev: s.srcRev, busy: s.busy, documentEpoch: s.documentEpoch, file: s.file,
  canonical: s.canonical && { id: s.canonical.id, rev: s.canonical.rev, pageCount: s.canonical.pageCount,
    runningRev: s.canonical.runningRev, scheduledRev: s.canonical.scheduledRev, inFlight: s.canonical.inFlight },
  queue: s.queue ?? s.queueLength ?? null, warm: s.warm ?? null,
});
const waitCanonical = async (label, limitMs) => {
  const deadline = Date.now() + limitMs;
  let last = null;
  while (Date.now() < deadline) {
    const s = await engineStatus();
    const c = compact(s);
    if (JSON.stringify(c) !== JSON.stringify(last)) { log(`${label}:status`, { status: c, lualatex: lualatexCount() }); last = c; }
    guardLualatex();
    if (s && s.canonical && s.canonical.rev === s.srcRev && s.canonical.pageCount >= 300 && !s.busy &&
        !s.canonical.inFlight && s.canonical.runningRev == null) return s;
    await sleep(2000);
  }
  throw new Error(`${label}: canonical did not converge`);
};
await waitCanonical('open', 15 * 60_000);

// ---- SSE recorder
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
          at: Date.now(), kind: m.kind, documentEpoch: m.documentEpoch,
          srcRev: r?.srcRev, rev: r?.rev ?? m.rev,
          stats: r?.stats && { totalUs: r.stats.totalUs, typesetMs: r.stats.typesetMs, rebooted: r.stats.rebooted ?? r.rebooted, blocksTypeset: r.stats.blocksTypeset, pagesReused: r.stats.pagesReused, pagesRebuilt: r.stats.pagesRebuilt, pageCount: r.stats.pageCount,
            chainVerdict: r.stats.chainVerdict, coldPending: r.stats.coldPending, diagnostics: r.stats.diagnostics?.slice?.(0, 12) },
          edit: r?.edit,
          patches: r?.patches?.map((p) => ({ type: p.type, page: p.page })),
          previewFallback: r?.previewFallback, canonicalAnchor: r?.canonicalAnchor ?? undefined,
          anchorRefused: r?.canonicalAnchorRefused ?? undefined,
          canonical: m.canonical && { id: m.canonical.id, rev: m.canonical.rev, pageCount: m.canonical.pageCount },
          anchorPatch: m.kind === 'canonical-anchor' ? { status: m.patch?.status, reason: m.patch?.reason, srcRev: m.patch?.srcRev, proofMs: m.patch?.proofMs, pages: m.patch?.pages?.map?.((p) => p.page ?? p) } : undefined,
          reason: m.reason,
        }) + '\n');
      }
    });
  });
  req.on('error', (e) => log('sse-error', { error: String(e) }));
  return req;
};
const sseReq = startSse();

// ---- helpers for frames
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
const liveFrameState = async () => {
  const f = page.frames().find((fr) => engineUrl && fr.url().startsWith(engineUrl));
  if (!f) return null;
  return f.evaluate(() => {
    const pages = document.getElementById('pages') || document.querySelector('.pages');
    return { scrollTop: pages?.scrollTop ?? null, appliedSrcRev: window.appliedSrcRev ?? null };
  }).catch(() => null);
};
const shot = async (name) => {
  try { await page.screenshot({ path: `${RUN}/shots/${name}.png` }); } catch (e) { log('shot-error', { name, error: String(e).slice(0, 200) }); }
};

// ---- Build
// A fresh profile opens Settings (runtime onboarding) over the workspace.
const dismissSettings = async () => {
  const open = await page.evaluate(() => document.getElementById('settings-pages')?.getAttribute('aria-hidden') === 'false');
  if (!open) return;
  await page.click('#settings-close').catch((e) => log('settings-close-error', { error: String(e).slice(0, 200) }));
  await sleep(800);
  log('settings-dismissed', { stillOpen: await page.evaluate(() => document.getElementById('settings-pages')?.getAttribute('aria-hidden') === 'false') });
};
await dismissSettings();
// ...and may show an update announcement on top.
for (let i = 0; i < 3; i += 1) {
  const open = await page.evaluate(() => document.getElementById('announcement-modal')?.classList.contains('is-open'));
  if (!open) break;
  await page.click('#announcement-modal-close').catch((e) => log('announcement-close-error', { error: String(e).slice(0, 200) }));
  await sleep(800);
  log('announcement-dismissed');
}
if (!SKIP_BUILD) {
  // Without the diagnostic app build, success is the Build's own output: a
  // newer main.pdf in the project (LIVEDIAG rows still count when present).
  const pdfPath = `${PROJECT}/main.pdf`;
  const mtime = () => (fs.existsSync(pdfPath) ? fs.statSync(pdfPath).mtimeMs : 0);
  const before = mtime();
  await page.click('#build-button');
  log('build-click');
  const deadline = Date.now() + 12 * 60_000;
  let built = false;
  while (Date.now() < deadline) {
    const rows = fs.existsSync(`${RUN}/renderer-diag.jsonl`) ? fs.readFileSync(`${RUN}/renderer-diag.jsonl`, 'utf8') : '';
    if (rows.includes('"clp:build-success"') || mtime() > before) { built = true; break; }
    guardLualatex();
    await sleep(1000);
  }
  if (!built) throw new Error('build did not succeed in time');
  log('build-success', { pdfMtime: mtime() });
}
// Let the Build-published PDF load in the right group. A fresh profile's
// first Build may not show it: open main.pdf from the file tree then.
const groupsState = () => page.evaluate(() => ({
  primary: [...document.querySelectorAll('.editor-group[data-editor-group="primary"] .editor-tab')].map((x) => ({ path: x.dataset.path, active: x.classList.contains('is-active') })),
  secondary: [...document.querySelectorAll('.editor-group[data-editor-group="secondary"] .editor-tab')].map((x) => ({ path: x.dataset.path, active: x.classList.contains('is-active') })),
  pdfs: [...document.querySelectorAll('button.file-item')].map((b) => b.dataset.path).filter((p) => p?.endsWith('.pdf')),
}));
let pdfLoaded = false;
for (let i = 0; i < 90 && !pdfLoaded; i += 1) {
  const s = await pdfState();
  if (s?.staticPages >= 300) { log('pdf-loaded', { pdf: s }); pdfLoaded = true; break; }
  if (i === 10 && !pdfFrame()) {
    await shot('build-no-pdf');
    log('no-pdf-frame', { groups: await groupsState() });
    // Not the file tree (that opens in the active group): an openFile the
    // renderer did not request is how the host pushes a PDF, and the app
    // then splits and shows it in the secondary group, as after a Build.
    await page.evaluate(() => window.tex64Bridge.postMessage({ type: 'openFile', path: 'main.pdf' }));
    log('open-main-pdf');
  }
  await sleep(1000);
}
if (!pdfLoaded) {
  await shot('pdf-missing');
  log('pdf-missing', { groups: await groupsState(), pdf: await pdfState() });
  throw new Error('PDF viewer did not load main.pdf');
}
await sleep(3000);
await waitCanonical('post-build', 10 * 60_000);

// ---- place static PDF at TARGET_PAGE
await pdfFrame().evaluate((n) => { window.__tex64PdfViewer.pdfViewer.currentPageNumber = n; }, TARGET_PAGE);
await sleep(1500);
// Without a Build hold the visible paper is the Live frame: move it with the
// toolbar's page input, which posts goto-page to the frame while Live.
if (/\bis-live\b/.test((await pdfState())?.body ?? '') && !/is-live-held/.test((await pdfState())?.body ?? '')) {
  await pdfFrame().evaluate((n) => {
    const input = document.getElementById('pdf-page-input');
    input.value = String(n);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, TARGET_PAGE);
  await sleep(2500);
}
log('pdf-positioned', { pdf: await pdfState() });

// ---- SCENARIO=restart-held: the engine dies while the Build PDF owns the
// paper. A restart is not a source change, so the static PDF must stay the
// visible paper through recovery and the recovered frame must arrive held.
if (process.env.SCENARIO === 'restart-held') {
  const before = await pdfState();
  log('restart-before', { pdf: before });
  execSync(`pkill -f ${JSON.stringify(`${ENGINE}/server.js`)} || true`);
  log('engine-killed');
  const seen = new Set();
  const deadline = Date.now() + 12 * 60_000;
  let recovered = false;
  while (Date.now() < deadline) {
    const s = await pdfState();
    const key = `${s?.body}|${s?.livePhase}|${s?.staticPage}|${s?.pageCount}`;
    if (!seen.has(key)) { seen.add(key); log('restart-state', { pdf: s }); }
    if (seen.size % 10 === 0) await shot(`restart-${Date.now()}`);
    engineUrl = null;
    const st = compact(await engineStatus());
    if (st && st.canonical?.rev === st.srcRev && st.canonical?.pageCount >= 300 && !st.busy && !st.canonical?.inFlight) {
      recovered = true;
      log('restart-recovered', { status: st, pdf: s });
      break;
    }
    guardLualatex();
    await sleep(2000);
  }
  if (!recovered) throw new Error('engine did not recover');
  await shot('restart-recovered');
  startSse(); // the recorder was bound to the dead engine's URL
}

// ---- open ch16 in the primary group via the file tree
await page.evaluate(() => {
  const tab = document.querySelector('.editor-group[data-editor-group="primary"] .editor-tab');
  tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  tab?.click();
});
await sleep(500);
await page.evaluate(() => document.querySelector('button.file-item[data-path="content/ch16.tex"]')?.click());
await sleep(3000);
const layout = await page.evaluate(() => ({
  primary: [...document.querySelectorAll('.editor-group[data-editor-group="primary"] .editor-tab')].map((x) => ({ path: x.dataset.path, active: x.classList.contains('is-active') })),
  secondary: [...document.querySelectorAll('.editor-group[data-editor-group="secondary"] .editor-tab')].map((x) => ({ path: x.dataset.path, active: x.classList.contains('is-active') })),
}));
log('layout', layout);

// ---- caret at ch16:33 after "iii"
const caret = await page.evaluate(() => {
  const editors = window.monaco?.editor?.getEditors?.() ?? [];
  const ed = editors.find((e) => e.getModel()?.uri?.path?.endsWith('/content/ch16.tex'));
  if (!ed) return { ok: false, reason: 'no editor', uris: editors.map((e) => e.getModel()?.uri?.path) };
  const text = ed.getValue();
  const line = text.split(/\r?\n/)[32] ?? '';
  const iii = line.indexOf('iii');
  if (iii < 0 || !line.includes('aaa')) return { ok: false, reason: 'line33 mismatch', line };
  const column = iii + 4;
  ed.setPosition({ lineNumber: 33, column });
  ed.setSelection({ startLineNumber: 33, startColumn: column, endLineNumber: 33, endColumn: column });
  ed.revealLineInCenter(33);
  ed.focus();
  window.__e2eEditor = ed;
  return { ok: true, text, column, line };
});
if (!caret.ok) throw new Error(`caret: ${JSON.stringify(caret)}`);
const caretOk = sha(caret.text) === CH16_SHA;
log('caret', { ok: caretOk, column: caret.column, line: caret.line });
if (!caretOk) throw new Error('ch16 model differs from the original');
await sleep(Number(process.env.WARM_WAIT_MS || 6000));
log('pre-input', { pdf: await pdfState(), status: compact(await engineStatus()) });
await shot('00-before');

// ---- input: one X by default; TYPE_TEXT/TYPE_DELAY_MS type a burst, and
// BACKSPACES then deletes that many characters BACKSPACE_AFTER_MS later
// (the continued-lineage anchor path: every keystroke re-plans on one base).
const TYPE_TEXT = process.env.TYPE_TEXT || 'X';
const TYPE_DELAY_MS = Number(process.env.TYPE_DELAY_MS || 0);
const BACKSPACES = Number(process.env.BACKSPACES || 0);
const BACKSPACE_AFTER_MS = Number(process.env.BACKSPACE_AFTER_MS || 4000);
let inputAt = Date.now();
await page.keyboard.type(TYPE_TEXT, { delay: TYPE_DELAY_MS });
log('input', { inputAt, text: TYPE_TEXT, typedMs: Date.now() - inputAt });
if (BACKSPACES > 0) {
  setTimeout(async () => {
    const at = Date.now();
    for (let i = 0; i < BACKSPACES; i += 1) {
      await page.keyboard.press('Backspace');
      if (TYPE_DELAY_MS) await sleep(TYPE_DELAY_MS);
    }
    log('backspaces', { at, dt: at - inputAt, count: BACKSPACES,
      line: (await page.evaluate(() => window.__e2eEditor.getValue())).split(/\r?\n/)[32] });
  }, BACKSPACE_AFTER_MS);
}
const after = await page.evaluate(() => window.__e2eEditor.getValue());
const expected = caret.text.split(/\r?\n/);
const got = after.split(/\r?\n/);
log('input-check', { lineAfter: got[32], sameOtherLines: expected.every((l, i) => i === 32 || l === got[i]) });

// ---- SCENARIO=stale-canonical: a canonical for an older revision lands
// while typing continues. Type Y while the canonical for X compiles, then Z
// after it lands, and record what the paper shows at each step.
if (process.env.SCENARIO === 'stale-canonical') {
  const status = async () => compact(await engineStatus());
  const waitFor = async (label, pred, limitMs) => {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      const s = await status();
      if (s && pred(s)) { log(label, { dt: Date.now() - inputAt, status: s }); return s; }
      guardLualatex();
      await sleep(1000);
    }
    throw new Error(`${label}: timeout`);
  };
  const burstShots = async (tag, seconds) => {
    for (let i = 0; i <= seconds * 2; i += 1) {
      if (i % 2 === 0 || i < 4) await shot(`${tag}-${String(Date.now() - inputAt).padStart(6, '0')}`);
      fs.appendFileSync(`${RUN}/samples.jsonl`, JSON.stringify({ dt: Date.now() - inputAt, tag, pdf: await pdfState() }) + '\n');
      await sleep(500);
    }
  };
  await burstShots('x', 3);
  const xRev = (await status()).srcRev;
  await waitFor('x-canonical-running', (s) => s.canonical?.runningRev === xRev, 180_000);
  await sleep(5000);
  await page.keyboard.type('Y');
  log('typed-y', { dt: Date.now() - inputAt });
  await burstShots('y', 4);
  // The canonical for the next revision may start at once: landing is its rev.
  await waitFor('x-canonical-landed', (s) => Number(s.canonical?.rev) >= xRev, 400_000);
  await burstShots('landed', 3);
  await page.keyboard.type('Z');
  log('typed-z', { dt: Date.now() - inputAt, line: (await page.evaluate(() => window.__e2eEditor.getValue())).split(/\r?\n/)[32] });
  await burstShots('z', 8);
}

// ---- CROSS_FILE: after the first file's edit (and its backspaces), open a
// second file, put the caret before the final 。 of CROSS_LINE, and type
// CROSS_TEXT. Issue #52 D: the anchor for this edit must not wait for the
// canonical of the first edit (the restored first file rebinds the last
// generation to the current revision).
if (process.env.CROSS_FILE) {
  const CROSS_FILE = process.env.CROSS_FILE;
  const CROSS_LINE = Number(process.env.CROSS_LINE || 171);
  const CROSS_TEXT = process.env.CROSS_TEXT || 'Q';
  const CROSS_PAGE = Number(process.env.CROSS_PAGE || 0);
  const CROSS_SHA = process.env.CROSS_SHA || null;
  if (BACKSPACES > 0) await sleep(BACKSPACE_AFTER_MS + 3000);
  else await sleep(3000);
  log('cross-before', { dt: Date.now() - inputAt, pdf: await pdfState(), status: compact(await engineStatus()),
    line33: (await page.evaluate(() => window.__e2eEditor.getValue())).split(/\r?\n/)[32] });
  await shot('cross-00-first-file-settled');
  await page.evaluate(() => {
    const tab = document.querySelector('.editor-group[data-editor-group="primary"] .editor-tab.is-active') ||
      document.querySelector('.editor-group[data-editor-group="primary"] .editor-tab');
    tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tab?.click();
  });
  await sleep(500);
  await page.evaluate((file) => document.querySelector(`button.file-item[data-path="${file}"]`)?.click(), CROSS_FILE);
  await sleep(3000);
  log('cross-layout', await groupsState());
  if (CROSS_PAGE > 0) {
    await pdfFrame()?.evaluate((n) => { if (window.__tex64PdfViewer?.pdfViewer) window.__tex64PdfViewer.pdfViewer.currentPageNumber = n; }, CROSS_PAGE).catch(() => {});
    await pdfFrame()?.evaluate((n) => {
      const input = document.getElementById('pdf-page-input');
      if (!input) return;
      input.value = String(n);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, CROSS_PAGE).catch(() => {});
    await sleep(2500);
    log('cross-pdf-positioned', { page: CROSS_PAGE, pdf: await pdfState() });
  }
  const crossCaret = await page.evaluate(({ file, line }) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const ed = editors.find((e) => e.getModel()?.uri?.path?.endsWith('/' + file));
    if (!ed) return { ok: false, reason: 'no editor', uris: editors.map((e) => e.getModel()?.uri?.path) };
    const text = ed.getValue();
    const lineText = text.split(/\r?\n/)[line - 1] ?? '';
    const stop = lineText.lastIndexOf('。');
    if (stop < 0) return { ok: false, reason: 'no 。 on line', lineText };
    const column = stop + 1;
    ed.setPosition({ lineNumber: line, column });
    ed.setSelection({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column });
    ed.revealLineInCenter(line);
    ed.focus();
    window.__e2eEditor = ed;
    return { ok: true, text, column, lineText };
  }, { file: CROSS_FILE, line: CROSS_LINE });
  if (!crossCaret.ok) throw new Error(`cross caret: ${JSON.stringify(crossCaret)}`);
  const crossShaOk = CROSS_SHA ? sha(crossCaret.text) === CROSS_SHA : null;
  log('cross-caret', { ok: crossShaOk, column: crossCaret.column, line: crossCaret.lineText });
  if (crossShaOk === false) throw new Error(`${CROSS_FILE} model differs from the original`);
  // A far-away caret walks the resident chain from its nearest checkpoint
  // (tens of seconds on 316 pages). Typing before that walk finishes pays
  // the same walk inside the edit (a known cold-edit limit, not the anchor
  // path): wait for the engine's warm state to report ready for this file.
  const crossLines = crossCaret.text.split(/\r?\n/);
  const crossOffset = crossLines.slice(0, CROSS_LINE - 1).reduce((n, l) => n + l.length + 1, 0) + crossCaret.column - 1;
  const warmStartedAt = Date.now();
  const warmBefore = await engineStatus();
  const warmSrcRev = warmBefore?.srcRev;
  const staleWarm = JSON.stringify(warmBefore?.warm ?? null);
  // CROSS_NO_WARM=1: type right away, before any caret warm reached this
  // block (the cold keystroke of tdom docs/10 §10.4a). The engine answers
  // within its cold budget and publishes the typeset as a deferred update.
  const noWarm = process.env.CROSS_NO_WARM === '1';
  if (!noWarm) await new Promise((resolve) => {
    const body = JSON.stringify({ offset: crossOffset, filePath: `${PROJECT}/${CROSS_FILE}` });
    const req = http.request(`${engineUrl}/warm`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', (e) => { log('cross-warm-error', { error: String(e) }); resolve(); });
    req.end(body);
  });
  const warmDeadline = Date.now() + Number(process.env.CROSS_WARM_MAX_MS || 180_000);
  let warmState = null;
  while (!noWarm && Date.now() < warmDeadline) {
    const st = await engineStatus();
    warmState = st?.warm ?? null;
    if (JSON.stringify(warmState) === staleWarm) { await sleep(500); continue; }
    if (warmState?.status === 'ready' && Number(warmState.sourceRev) === Number(warmSrcRev)) break;
    if (['proof-unavailable', 'error', 'rejected'].includes(warmState?.status)) break;
    guardLualatex();
    await sleep(500);
  }
  log('cross-warm', { waitedMs: Date.now() - warmStartedAt, offset: crossOffset, warm: warmState, skipped: noWarm });
  await sleep(Number(process.env.WARM_WAIT_MS || (noWarm ? 0 : 6000)));
  log('cross-pre-input', { pdf: await pdfState(), status: compact(await engineStatus()) });
  await shot('cross-01-before-input');
  inputAt = Date.now();
  await page.keyboard.type(CROSS_TEXT, { delay: TYPE_DELAY_MS });
  log('cross-input', { inputAt, text: CROSS_TEXT, file: CROSS_FILE, line: CROSS_LINE,
    lineAfter: (await page.evaluate(() => window.__e2eEditor.getValue())).split(/\r?\n/)[CROSS_LINE - 1] });
  for (let i = 0; i < Number(process.env.CROSS_SAMPLE_COUNT || 24); i += 1) {
    if (i % 2 === 0 || i < 4) await shot(`cross-${String(Date.now() - inputAt).padStart(6, '0')}`);
    fs.appendFileSync(`${RUN}/samples.jsonl`, JSON.stringify({ dt: Date.now() - inputAt, tag: 'cross', pdf: await pdfState(), status: compact(await engineStatus()) }) + '\n');
    await sleep(500);
  }
}

// ---- observe
const samples = [];
let lastKey = '';
for (let i = 0; i < 120; i += 1) {
  const at = Date.now();
  const s = await pdfState();
  const key = JSON.stringify(s);
  if (key !== lastKey) { samples.push({ dt: at - inputAt, pdf: s }); fs.appendFileSync(`${RUN}/samples.jsonl`, JSON.stringify({ dt: at - inputAt, pdf: s }) + '\n'); lastKey = key; }
  if (i % 5 === 0 && i <= 60) await shot(`t${String(at - inputAt).padStart(5, '0')}`);
  await sleep(100);
}
for (let i = 0; i < 90; i += 1) {
  const st = compact(await engineStatus());
  const s = await pdfState();
  fs.appendFileSync(`${RUN}/samples.jsonl`, JSON.stringify({ dt: Date.now() - inputAt, pdf: s, status: st }) + '\n');
  if (i % 5 === 0) await shot(`late-${String(Date.now() - inputAt).padStart(6, '0')}`);
  if (st && st.canonical?.rev === st.srcRev && !st.busy && !st.canonical?.inFlight && st.canonical?.runningRev == null && i > 3) break;
  await sleep(2000);
}
await shot('99-final');
log('final', { pdf: await pdfState(), status: compact(await engineStatus()), ch16Disk: fs.readFileSync(`${PROJECT}/content/ch16.tex`, 'utf8').split(/\r?\n/)[32] });
sseReq.destroy();
if (process.env.KEEP_OPEN !== '1') {
  await app.close();
  log('closed');
}
