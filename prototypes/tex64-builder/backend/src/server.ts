import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// backend/.env を読み込む(dotenv不使用の軽量版)
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const env = readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // .env が無ければ環境変数のみ
}

const { initAi, aiAvailable, runChat, describeToLatex, ocrToLatex } = await import('./ai.js');
const { compileDoc } = await import('./compile.js');

const hasAi = initAi();
const app = express();
app.use(express.json({ limit: '30mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ai: aiAvailable() });
});

/* チャット (SSE) */
app.post('/api/chat', async (req, res) => {
  const { history = [], text = '', doc, mode = 'edit' } = req.body ?? {};
  if (!doc || typeof text !== 'string') {
    res.status(400).end();
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  try {
    await runChat(history, text, doc, mode === 'discuss' ? 'discuss' : 'edit', emit);
  } catch (err) {
    console.error('[chat] error:', err);
    emit({
      type: 'notice',
      text: '応答の生成に失敗しました。少し待ってからもう一度お試しください。',
    });
    emit({ type: 'done' });
  }
  res.end();
});

/* コンパイル → PDF */
app.post('/api/compile', async (req, res) => {
  const { doc } = req.body ?? {};
  if (!doc) {
    res.status(400).end();
    return;
  }
  try {
    const result = await compileDoc(doc);
    if (!result) {
      res.status(204).end();
      return;
    }
    res.setHeader('X-Compile', result.stale ? 'stale' : 'ok');
    res.type('application/pdf').send(result.pdf);
  } catch (err) {
    console.error('[compile] error:', err);
    res.status(204).end();
  }
});

/* 数式: 説明 → LaTeX */
app.post('/api/math/describe', async (req, res) => {
  const { description = '' } = req.body ?? {};
  const latex = description ? await describeToLatex(String(description)) : null;
  res.json({ latex });
});

/* 数式: 写真 → LaTeX (OCR) */
app.post('/api/math/ocr', async (req, res) => {
  const { image = '' } = req.body ?? {};
  const latex = image ? await ocrToLatex(String(image)) : null;
  res.json({ latex });
});

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  console.log(`[tex64-backend] http://localhost:${port} (AI: ${hasAi ? 'ready' : 'no API key'})`);
});
