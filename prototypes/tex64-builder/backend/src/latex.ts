import type { Block, DocumentModel } from './types.js';

/** LaTeX特殊文字のエスケープ */
const SPECIALS: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '^': '\\textasciicircum{}',
  _: '\\_',
  '%': '\\%',
  '~': '\\textasciitilde{}',
};

export function escapeLatex(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, (c) => SPECIALS[c]);
}

function decodeEntities(html: string): string {
  return html
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&dagger;/g, '†')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/**
 * contenteditable由来の簡易HTML(<b>/<i>/<em>/<strong>/<sup>/<br>/<div>)をLaTeXへ変換。
 * 未知のタグは無視し、テキストはエスケープする。
 */
export function htmlToLatex(html: string): string {
  const decodedTokens = html.split(/(<[^>]*>)/);
  const stack: string[] = [];
  let out = '';

  for (const token of decodedTokens) {
    if (!token) continue;
    if (token.startsWith('<')) {
      const m = /^<\s*(\/)?\s*([a-zA-Z0-9]+)/.exec(token);
      if (!m) continue;
      const closing = Boolean(m[1]);
      const tag = m[2].toLowerCase();
      if (!closing) {
        if (tag === 'b' || tag === 'strong') {
          out += '\\textbf{';
          stack.push('}');
        } else if (tag === 'i' || tag === 'em') {
          out += '\\emph{';
          stack.push('}');
        } else if (tag === 'sup') {
          out += '\\textsuperscript{';
          stack.push('}');
        } else if (tag === 'br') {
          out += '\\\\ ';
        }
        // div/p/span等は無視(divは改行相当だが段落内では詰める)
      } else {
        if (['b', 'strong', 'i', 'em', 'sup'].includes(tag) && stack.length > 0) {
          out += stack.pop();
        }
      }
    } else {
      out += escapeLatex(decodeEntities(token));
    }
  }
  while (stack.length > 0) out += stack.pop();
  return out.trim();
}

const PREAMBLE = `\\documentclass[a4paper,10pt]{ltjsarticle}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[top=26mm,bottom=30mm,left=26mm,right=26mm]{geometry}
\\usepackage{caption}
\\DeclareCaptionLabelSeparator{emdash}{ --- }
\\captionsetup{labelsep=emdash,font={small,it}}
\\setlength{\\parskip}{0.2\\baselineskip}
`;

export interface FigureAsset {
  filename: string;
  data: Buffer;
}

export interface LatexOutput {
  source: string;
  figures: FigureAsset[];
}

function dataUrlToBuffer(src: string): { data: Buffer; ext: string } | null {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/.exec(src);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  return { data: Buffer.from(m[2], 'base64'), ext };
}

/** documentModel → LaTeXソース。プリアンブルは製品側で固定管理する。 */
export function docToLatex(doc: DocumentModel): LatexOutput {
  const figures: FigureAsset[] = [];
  const body: string[] = [];

  const author = doc.meta.split('·')[0]?.trim() || ' ';
  const date = doc.meta.split('·')[1]?.trim() || '';

  body.push(`\\title{${htmlToLatex(doc.title)}}`);
  body.push(`\\author{${escapeLatex(author)}}`);
  body.push(`\\date{${escapeLatex(date)}}`);
  body.push('\\begin{document}');
  body.push('\\maketitle');

  let figNo = 0;
  for (const b of doc.blocks as Block[]) {
    switch (b.type) {
      case 'abstract':
        body.push('\\begin{abstract}');
        body.push(htmlToLatex(b.html));
        body.push('\\end{abstract}');
        break;
      case 'heading':
        body.push(`\\section{${htmlToLatex(b.html)}}`);
        break;
      case 'paragraph':
        body.push('');
        body.push(htmlToLatex(b.html));
        break;
      case 'equation':
        body.push('\\begin{equation}');
        body.push(b.latex);
        body.push('\\end{equation}');
        break;
      case 'figure': {
        figNo += 1;
        const caption = htmlToLatex(b.caption) || ' ';
        if (b.src) {
          const img = dataUrlToBuffer(b.src);
          if (img) {
            const filename = `fig${figNo}.${img.ext}`;
            figures.push({ filename, data: img.data });
            body.push('\\begin{figure}[htbp]');
            body.push('\\centering');
            body.push(`\\includegraphics[width=0.72\\linewidth]{${filename}}`);
            body.push(`\\caption{${caption}}`);
            body.push('\\end{figure}');
            break;
          }
        }
        // 画像未挿入のプレースホルダーは枠として組版
        body.push('\\begin{figure}[htbp]');
        body.push('\\centering');
        body.push(
          '\\fbox{\\parbox[c][34mm][c]{0.7\\linewidth}{\\centering \\small ここに画像が入ります}}',
        );
        body.push(`\\caption{${caption}}`);
        body.push('\\end{figure}');
        break;
      }
      case 'references':
        if (b.items.length > 0) {
          body.push('\\begin{thebibliography}{9}');
          for (const item of b.items) {
            body.push(`\\bibitem{ref${body.length}} ${escapeLatex(item)}`);
          }
          body.push('\\end{thebibliography}');
        }
        break;
    }
  }

  body.push('\\end{document}');
  return { source: `${PREAMBLE}\n${body.join('\n')}\n`, figures };
}
