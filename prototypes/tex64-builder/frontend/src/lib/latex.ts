import katex from 'katex';

export const ATTENTION_LATEX =
  '\\mathrm{Attention}(Q,\\,K,\\,V) = \\mathrm{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V';

export const MULTIHEAD_LATEX =
  '\\mathrm{MultiHead}(Q,K,V) = \\mathrm{Concat}(\\mathrm{head}_1,\\ldots,\\mathrm{head}_h)\\,W^{O}';

/**
 * 数式をKaTeXでHTMLへ組版する。
 * 不正なソースの場合は直前の有効な描画結果を返す(エラーは決してUIに露出させない)。
 */
export function renderLatex(latex: string, fallbackHtml = ''): string {
  try {
    return katex.renderToString(latex, {
      displayMode: true,
      throwOnError: true,
      strict: false,
      output: 'html',
    });
  } catch {
    return fallbackHtml;
  }
}

/** 自然文の説明→LaTeXへのモック変換(バックエンド実装までの代替) */
export function describeToLatex(desc: string): string {
  const d = desc.toLowerCase();
  const has = (...words: string[]) => words.some((w) => d.includes(w.toLowerCase()));

  if (has('ソフトマックス', 'softmax', '注意', 'attention', '転置')) return ATTENTION_LATEX;
  if (has('マルチヘッド', 'multihead', '多頭')) return MULTIHEAD_LATEX;
  if (has('平均', 'mean')) return '\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i';
  if (has('解の公式', '二次方程式')) return 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}';
  if (has('正規分布', 'ガウス', 'gauss'))
    return 'f(x) = \\frac{1}{\\sqrt{2\\pi\\sigma^2}}\\, e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}';
  if (has('交差エントロピー', '損失', 'loss')) return 'L = -\\sum_{i} y_i \\log \\hat{y}_i';
  if (has('オイラー', 'euler')) return 'e^{i\\pi} + 1 = 0';
  if (has('勾配', '偏微分'))
    return '\\theta_{t+1} = \\theta_t - \\eta\\, \\nabla_{\\theta} L(\\theta_t)';
  if (has('フーリエ', 'fourier'))
    return '\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x)\\, e^{-2\\pi i x \\xi}\\, dx';
  return '\\hat{y} = f(x;\\, \\theta)';
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let counter = 0;
export function uid(): string {
  counter += 1;
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${counter}`;
}
