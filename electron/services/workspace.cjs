const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tex64",
  ".swiftpm",
  "node_modules",
  "DerivedData",
  "build",
  "tex64.xcodeproj",
]);
const HIDDEN_EDITOR_EXTENSIONS = new Set([
  "aux",
  "toc",
  "synctex",
  "fls",
  "fdb_latexmk",
]);
const IGNORED_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

const TEMPLATE_LUALATEX_EN = String.raw`% !TEX program = lualatex
% !TEX root = main.tex
\documentclass[a4paper,11pt]{article}

% ---------- Layout & typography ----------
\usepackage[margin=25mm]{geometry}
\usepackage{microtype}
\usepackage{lmodern}

% ---------- Math ----------
\usepackage{amsmath, amssymb, mathtools}
\usepackage{amsthm}

% ---------- Figures & tables ----------
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{subcaption}
\usepackage{xcolor}

% ---------- Lists, quotes, code ----------
\usepackage{enumitem}
\usepackage{csquotes}
\usepackage{listings}

% ---------- Cross-references & links (load late) ----------
\usepackage{hyperref}
\hypersetup{
  colorlinks=true,
  linkcolor=blue!60!black,
  urlcolor=blue!60!black,
  citecolor=blue!60!black,
}

% ---------- Theorem environments ----------
\theoremstyle{plain}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{proposition}[theorem]{Proposition}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}
\newtheorem{example}[theorem]{Example}
\theoremstyle{remark}
\newtheorem*{remark}{Remark}

% ---------- Listings style ----------
\lstdefinestyle{code}{
  basicstyle=\ttfamily\small,
  keywordstyle=\color{blue!60!black}\bfseries,
  commentstyle=\color{gray},
  stringstyle=\color{teal},
  numbers=left,
  numberstyle=\tiny\color{gray},
  showstringspaces=false,
  breaklines=true,
  frame=single,
  framerule=0.5pt,
  rulecolor=\color{gray!50},
}
\lstset{style=code}

% ---------- Custom shortcuts ----------
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}

\title{Document Title}
\author{Your Name\\\small \texttt{your.email@example.com}}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
A short summary of the document goes here. State the problem, your approach,
and the main result in two or three sentences.
\end{abstract}

\tableofcontents
\bigskip

\section{Introduction}
\label{sec:intro}

Write your text in paragraphs separated by blank lines.
Use \emph{emphasis} for stress and \textbf{bold} for strong emphasis.
Footnotes\footnote{Footnotes appear at the bottom of the page.} are
straightforward.

External links are clickable: \url{https://example.org}, or with
custom anchor text: \href{https://example.org}{example site}.

\section{Mathematics}
\label{sec:math}

Inline math like $a^2 + b^2 = c^2$ flows with the surrounding text.
Display math gets its own line:
\begin{equation}
  \label{eq:euler}
  e^{i\pi} + 1 = 0.
\end{equation}
Refer to~\eqref{eq:euler} as needed.

Aligned equations:
\begin{align}
  (x + y)^2 &= x^2 + 2xy + y^2, \\
  (x - y)^2 &= x^2 - 2xy + y^2.
\end{align}

Cases:
\begin{equation}
  \abs{x} =
  \begin{cases}
    x  & \text{if } x \ge 0, \\
    -x & \text{otherwise.}
  \end{cases}
\end{equation}

Matrices:
\begin{equation}
  A =
  \begin{pmatrix}
    a_{11} & a_{12} \\
    a_{21} & a_{22}
  \end{pmatrix},
  \qquad
  \det A = a_{11} a_{22} - a_{12} a_{21}.
\end{equation}

\subsection{Theorems and proofs}

\begin{definition}
  Let $f \colon \R \to \R$ be a function. We say $f$ is \emph{continuous} at
  $x_0 \in \R$ if for every $\varepsilon > 0$ there exists $\delta > 0$ such
  that $\abs{x - x_0} < \delta$ implies $\abs{f(x) - f(x_0)} < \varepsilon$.
\end{definition}

\begin{theorem}[Pythagoras]
  \label{thm:pythagoras}
  In a right triangle with legs $a$, $b$ and hypotenuse $c$,
  \[
    a^2 + b^2 = c^2.
  \]
\end{theorem}

\begin{proof}
  Omitted; see any standard reference~\cite{euclid}.
\end{proof}

\begin{remark}
  Theorem~\ref{thm:pythagoras} extends to higher dimensions via
  inner-product spaces.
\end{remark}

\section{Lists, quotes, and code}

\subsection{Lists}

A bulleted list:
\begin{itemize}
  \item First item.
  \item Second item, with a nested list:
  \begin{itemize}
    \item Nested item.
  \end{itemize}
\end{itemize}

A numbered list with custom labels:
\begin{enumerate}[label=(\alph*)]
  \item Step one.
  \item Step two.
\end{enumerate}

A description list:
\begin{description}
  \item[Domain] The set of inputs.
  \item[Codomain] The set of possible outputs.
\end{description}

\subsection{Block quote}

\begin{displayquote}
  Mathematics is the language with which God has written the universe.
  \hfill --- attributed to Galileo
\end{displayquote}

\subsection{Code listing}

\begin{lstlisting}[language=Python, caption={A short example.}, label={lst:example}]
def fib(n):
    """Return the n-th Fibonacci number."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{lstlisting}

Listing~\ref{lst:example} shows an iterative helper.

\section{Figures and tables}

\subsection{A single figure}

\begin{figure}[ht]
  \centering
  % \includegraphics[width=0.6\linewidth]{example}
  \fbox{\rule{0pt}{6em}\rule{0.6\linewidth}{0pt}}
  \caption{Replace the placeholder above with \texttt{\textbackslash includegraphics}.}
  \label{fig:example}
\end{figure}

\subsection{Side-by-side subfigures}

\begin{figure}[ht]
  \centering
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{Left subfigure.}
    \label{fig:left}
  \end{subfigure}\hfill
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{Right subfigure.}
    \label{fig:right}
  \end{subfigure}
  \caption{A figure made of two subfigures.}
  \label{fig:subs}
\end{figure}

See Figure~\ref{fig:example}, and the panels in Figure~\ref{fig:subs}
(\subref{fig:left} and \subref{fig:right}).

\subsection{A table}

\begin{table}[ht]
  \centering
  \caption{A booktabs-style table.}
  \label{tab:example}
  \begin{tabular}{lrr}
    \toprule
    Item     & Count & Mean (s) \\
    \midrule
    Method A &   120 & 0.42 \\
    Method B &    85 & 0.31 \\
    Method C &   210 & 0.58 \\
    \midrule
    Total    &   415 & 0.44 \\
    \bottomrule
  \end{tabular}
\end{table}

Table~\ref{tab:example} summarises the three methods.

\section{Conclusion}

Summarise your contributions and outline future work.

\section*{Acknowledgements}

The author thanks the open-source community for the LaTeX ecosystem.

\begin{thebibliography}{9}
  \bibitem{euclid}
    Euclid, \emph{Elements}, ca.\ 300 BCE.
  \bibitem{knuth1984}
    D.~E.\ Knuth, \emph{The TeXbook}, Addison--Wesley, 1984.
\end{thebibliography}

\end{document}
`;

const TEMPLATE_LUALATEX_JA = String.raw`% !TEX program = lualatex
% !TEX root = main.tex
\documentclass[a4paper,11pt]{ltjsarticle}

% ---------- レイアウト・タイポグラフィ ----------
\usepackage[margin=25mm]{geometry}
\usepackage{microtype}

% ---------- 数式 ----------
\usepackage{amsmath, amssymb, mathtools}
\usepackage{amsthm}

% ---------- 図表 ----------
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{subcaption}
\usepackage{xcolor}

% ---------- リスト・引用・コード ----------
\usepackage{enumitem}
\usepackage{csquotes}
\usepackage{listings}

% ---------- 相互参照・リンク（最後に読み込む） ----------
\usepackage{hyperref}
\hypersetup{
  colorlinks=true,
  linkcolor=blue!60!black,
  urlcolor=blue!60!black,
  citecolor=blue!60!black,
}

% ---------- 定理環境 ----------
\theoremstyle{plain}
\newtheorem{theorem}{定理}[section]
\newtheorem{lemma}[theorem]{補題}
\newtheorem{proposition}[theorem]{命題}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{定義}
\newtheorem{example}[theorem]{例}
\theoremstyle{remark}
\newtheorem*{remark}{注意}
\renewcommand{\proofname}{証明}

% ---------- リスティングのスタイル ----------
\lstdefinestyle{code}{
  basicstyle=\ttfamily\small,
  keywordstyle=\color{blue!60!black}\bfseries,
  commentstyle=\color{gray},
  stringstyle=\color{teal},
  numbers=left,
  numberstyle=\tiny\color{gray},
  showstringspaces=false,
  breaklines=true,
  frame=single,
  framerule=0.5pt,
  rulecolor=\color{gray!50},
}
\lstset{style=code}

% ---------- 独自ショートカット ----------
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}

\title{タイトル}
\author{著者名\\\small \texttt{your.email@example.com}}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
ここに概要を書きます。問題設定・アプローチ・主要な結果を 2〜3 文でまとめます。
\end{abstract}

\tableofcontents
\bigskip

\section{はじめに}
\label{sec:intro}

段落は空行で区切ります。\emph{強調}や\textbf{太字}も使えます。
脚注\footnote{脚注は同じページの下部に表示されます。}も自然に扱えます。

外部リンクはそのまま貼れます: \url{https://example.org}。
別表記のリンクも可能です: \href{https://example.org}{サンプルサイト}。

\section{数式}
\label{sec:math}

文中の数式は $a^2 + b^2 = c^2$ のように地の文に溶け込みます。
別行立ては独立した行に表示されます:
\begin{equation}
  \label{eq:euler}
  e^{i\pi} + 1 = 0.
\end{equation}
式~\eqref{eq:euler}のように参照できます。

整列した式:
\begin{align}
  (x + y)^2 &= x^2 + 2xy + y^2, \\
  (x - y)^2 &= x^2 - 2xy + y^2.
\end{align}

場合分け:
\begin{equation}
  \abs{x} =
  \begin{cases}
    x  & (x \ge 0 \text{ のとき}), \\
    -x & (\text{それ以外}).
  \end{cases}
\end{equation}

行列:
\begin{equation}
  A =
  \begin{pmatrix}
    a_{11} & a_{12} \\
    a_{21} & a_{22}
  \end{pmatrix},
  \qquad
  \det A = a_{11} a_{22} - a_{12} a_{21}.
\end{equation}

\subsection{定理と証明}

\begin{definition}
  関数 $f \colon \R \to \R$ が点 $x_0 \in \R$ で\emph{連続}であるとは、
  任意の $\varepsilon > 0$ に対してある $\delta > 0$ が存在して、
  $\abs{x - x_0} < \delta$ ならば $\abs{f(x) - f(x_0)} < \varepsilon$ が成り立つことをいう。
\end{definition}

\begin{theorem}[ピタゴラスの定理]
  \label{thm:pythagoras}
  直角三角形の 2 辺の長さを $a$, $b$、斜辺を $c$ とすると、
  \[
    a^2 + b^2 = c^2.
  \]
\end{theorem}

\begin{proof}
  証明は省略する。標準的な参考文献~\cite{euclid}を参照のこと。
\end{proof}

\begin{remark}
  定理~\ref{thm:pythagoras}は内積空間における高次元化が知られている。
\end{remark}

\section{リスト・引用・コード}

\subsection{リスト}

箇条書き:
\begin{itemize}
  \item 1 つめの項目。
  \item 2 つめの項目（入れ子にもできる）:
  \begin{itemize}
    \item ネストした項目。
  \end{itemize}
\end{itemize}

ラベルを変えた番号付きリスト:
\begin{enumerate}[label=(\alph*)]
  \item 手順 1。
  \item 手順 2。
\end{enumerate}

定義リスト:
\begin{description}
  \item[定義域] 入力の集合。
  \item[値域] 出力になりうる値の集合。
\end{description}

\subsection{ブロック引用}

\begin{displayquote}
  数学とは、神が宇宙を記述するために用いた言語である。
  \hfill --- ガリレオ・ガリレイ（伝）
\end{displayquote}

\subsection{コードリスティング}

\begin{lstlisting}[language=Python, caption={短い例。}, label={lst:example}]
def fib(n):
    """n 番目のフィボナッチ数を返す。"""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{lstlisting}

リスト~\ref{lst:example}は反復版のヘルパーを示す。

\section{図と表}

\subsection{図}

\begin{figure}[ht]
  \centering
  % \includegraphics[width=0.6\linewidth]{example}
  \fbox{\rule{0pt}{6em}\rule{0.6\linewidth}{0pt}}
  \caption{プレースホルダーは \texttt{\textbackslash includegraphics} で置き換えてください。}
  \label{fig:example}
\end{figure}

\subsection{2 枚並べた図}

\begin{figure}[ht]
  \centering
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{左の図。}
    \label{fig:left}
  \end{subfigure}\hfill
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{右の図。}
    \label{fig:right}
  \end{subfigure}
  \caption{2 枚の小図からなる図。}
  \label{fig:subs}
\end{figure}

図~\ref{fig:example}と、図~\ref{fig:subs}の各パネル
(\subref{fig:left}, \subref{fig:right}) を参照のこと。

\subsection{表}

\begin{table}[ht]
  \centering
  \caption{booktabs スタイルの表。}
  \label{tab:example}
  \begin{tabular}{lrr}
    \toprule
    項目     & 件数 & 平均 (秒) \\
    \midrule
    手法 A   &  120 & 0.42 \\
    手法 B   &   85 & 0.31 \\
    手法 C   &  210 & 0.58 \\
    \midrule
    合計     &  415 & 0.44 \\
    \bottomrule
  \end{tabular}
\end{table}

表~\ref{tab:example}は 3 手法の比較である。

\section{まとめ}

主な貢献を要約し、今後の課題を述べる。

\section*{謝辞}

LaTeX エコシステムを支える OSS コミュニティに感謝する。

\begin{thebibliography}{9}
  \bibitem{euclid}
    Euclid, \emph{Elements}, ca.\ 300 BCE.
  \bibitem{knuth1984}
    D.~E.\ Knuth, \emph{The \TeX book}, Addison--Wesley, 1984.
\end{thebibliography}

\end{document}
`;

const WorkspaceError = {
  invalidPath: "Invalid path.",
  invalidName: "Invalid name.",
  invalidEncoding: "Non-UTF-8 encoding.",
  alreadyExists: "Already exists.",
  notFound: "not found。",
  notEmpty: "Folder is not empty.",
  invalidMove: "Invalid destination.",
  cancelled: "Cancelled.",
  unknown: "Failed to create project.",
};

const normalizeRelativePath = (relativePath) => {
  if (!relativePath) {
    return "";
  }
  return relativePath.split(path.sep).join("/");
};

const generateId = () => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
};

const isHiddenName = (name) => name.startsWith(".");
const isHiddenEditorFile = (name) => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".synctex.gz")) {
    return true;
  }
  const ext = path.extname(lower);
  if (!ext) {
    return false;
  }
  return HIDDEN_EDITOR_EXTENSIONS.has(ext.slice(1));
};
const isIgnoredFile = (name) => IGNORED_FILES.has(name);

const ensureDirectory = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const readUtf8File = async (filePath) => {
  const data = await fsp.readFile(filePath);
  const content = data.toString("utf8");
  if (!content && data.length > 0) {
    throw new Error(WorkspaceError.invalidEncoding);
  }
  return content;
};

const writeUtf8File = async (filePath, content) => {
  const buffer = Buffer.from(content, "utf8");
  await fsp.writeFile(filePath, buffer);
};

const extractTexMagicRoot = (content) => {
  if (!content) {
    return null;
  }
  const lines = content.split(/\r?\n/).slice(0, 40);
  for (const line of lines) {
    const match = line.match(/^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/i);
    if (!match) {
      continue;
    }
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      continue;
    }
    const unquoted = raw.replace(/^['"]|['"]$/g, "").trim();
    if (!unquoted) {
      continue;
    }
    return unquoted;
  }
  return null;
};

class WorkspaceManager {
  constructor() {
    this.rootPath = null;
    this.rootFileInfo = null;
    this.rootInfoRootPath = null;
    this.undoStack = [];
  }

  setRootPath(rootPath) {
    this.rootPath = rootPath;
    this.rootFileInfo = null;
    this.rootInfoRootPath = null;
    this.undoStack = [];
  }

  getRootPath() {
    return this.rootPath;
  }

  resolvePath(relativePath) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (relativePath ?? "").trim();
    const resolved = path.resolve(this.rootPath, trimmed);
    const rootResolved = path.resolve(this.rootPath);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(WorkspaceError.invalidPath);
    }
    return resolved;
  }

  async rootInfo() {
    if (!this.rootPath) {
      return null;
    }
    if (this.rootInfoRootPath !== this.rootPath) {
      this.rootInfoRootPath = this.rootPath;
      this.rootFileInfo = null;
    }
    if (this.rootFileInfo) {
      return this.rootFileInfo;
    }
    const settings = await this.loadSettings().catch(() => null);
    if (settings?.rootFile) {
      const resolved = this.resolvePath(settings.rootFile);
      const exists = await fsp
        .stat(resolved)
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (exists) {
        this.rootFileInfo = { path: settings.rootFile, source: "manual" };
        return this.rootFileInfo;
      }
    }
    const autoRoot = await this.detectRootFile();
    if (autoRoot) {
      this.rootFileInfo = { path: autoRoot, source: "auto" };
      return this.rootFileInfo;
    }
    return null;
  }

  async setRootFile(pathValue) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (pathValue ?? "").trim();
    if (!trimmed) {
      return this.clearRootOverride();
    }
    const resolved = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(WorkspaceError.invalidPath);
    }
    if (path.extname(resolved).toLowerCase() !== ".tex") {
      throw new Error(WorkspaceError.invalidPath);
    }
    this.rootFileInfo = { path: normalizeRelativePath(trimmed), source: "manual" };
    this.rootInfoRootPath = this.rootPath;
    await this.updateSettings((settings) => {
      settings.rootFile = normalizeRelativePath(trimmed);
      return settings;
    });
    return this.rootFileInfo;
  }

  async clearRootOverride() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    this.rootInfoRootPath = this.rootPath;
    const autoRoot = await this.detectRootFile();
    if (autoRoot) {
      this.rootFileInfo = { path: autoRoot, source: "auto" };
    } else {
      this.rootFileInfo = null;
    }
    await this.updateSettings((settings) => {
      delete settings.rootFile;
      return settings;
    });
    return this.rootFileInfo;
  }

  async listFiles() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const results = [];
    await this.walkEntries({
      onFile: (relativePath, absolutePath) => {
        const name = path.basename(absolutePath);
        if (isHiddenEditorFile(name)) {
          return;
        }
        results.push(relativePath);
      },
      limit: 5000,
    });
    return results.sort((a, b) => a.localeCompare(b, "ja"));
  }

  async listFolders() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const results = [];
    await this.walkEntries({
      onDirectory: (relativePath) => {
        if (relativePath) {
          results.push(relativePath);
        }
      },
      limit: 5000,
    });
    return results.sort((a, b) => a.localeCompare(b, "ja"));
  }

  async readFile(relativePath) {
    const resolved = this.resolvePath(relativePath);
    const content = await readUtf8File(resolved);
    return content;
  }

  async readBinaryFile(relativePath) {
    const resolved = this.resolvePath(relativePath);
    return fsp.readFile(resolved);
  }

  async writeFile(relativePath, content) {
    const resolved = this.resolvePath(relativePath);
    await writeUtf8File(resolved, content);
  }

  async createFile(relativePath) {
    const resolved = this.resolvePath(relativePath);
    const exists = await fsp.stat(resolved).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await ensureDirectory(path.dirname(resolved));
    await writeUtf8File(resolved, "");
  }

  async createFolder(relativePath) {
    const resolved = this.resolvePath(relativePath);
    const exists = await fsp.stat(resolved).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await ensureDirectory(resolved);
  }

  async renameItem(relativePath, newName) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (newName ?? "").trim();
    if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
      throw new Error(WorkspaceError.invalidName);
    }
    const resolved = this.resolvePath(relativePath);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }
    const parentDir = path.dirname(resolved);
    const target = path.join(parentDir, trimmed);
    const exists = await fsp.stat(target).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await fsp.rename(resolved, target);
    const newRelative = normalizeRelativePath(path.relative(this.rootPath, target));
    this.updateRootOverrideAfterRename(relativePath, newRelative);
    return newRelative;
  }

  async moveItem(relativePath, destinationFolder) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolvedSource = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolvedSource).catch(() => null);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }

    let resolvedDestination;
    const destinationTrimmed = (destinationFolder ?? "").trim();
    if (!destinationTrimmed) {
      resolvedDestination = this.rootPath;
    } else {
      resolvedDestination = this.resolvePath(destinationTrimmed);
      const destStat = await fsp.stat(resolvedDestination).catch(() => null);
      if (!destStat || !destStat.isDirectory()) {
        throw new Error(WorkspaceError.invalidMove);
      }
    }

    const sourcePath = path.resolve(resolvedSource);
    const destinationPath = path.resolve(resolvedDestination);
    if (stat.isDirectory()) {
      if (destinationPath === sourcePath || destinationPath.startsWith(sourcePath + path.sep)) {
        throw new Error(WorkspaceError.invalidMove);
      }
    }

    const target = path.join(destinationPath, path.basename(sourcePath));
    if (path.resolve(target) === sourcePath) {
      return normalizeRelativePath(trimmed);
    }
    const exists = await fsp.stat(target).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }

    await fsp.rename(sourcePath, target);
    const newRelative = normalizeRelativePath(path.relative(this.rootPath, target));
    this.updateRootOverrideAfterRename(trimmed, newRelative);

    const affectsIndex =
      stat.isDirectory() ||
      this.isIndexTarget(trimmed) ||
      this.isIndexTarget(newRelative);
    this.undoStack.push({
      kind: "move",
      fromPath: normalizeRelativePath(trimmed),
      toPath: newRelative,
      isDirectory: stat.isDirectory(),
      affectsIndex,
      trashedPath: null,
    });
    return newRelative;
  }

  async copyItem(relativePath, destinationFolder) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolvedSource = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolvedSource).catch(() => null);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }

    let resolvedDestination;
    const destinationTrimmed = (destinationFolder ?? "").trim();
    if (!destinationTrimmed) {
      resolvedDestination = this.rootPath;
    } else {
      resolvedDestination = this.resolvePath(destinationTrimmed);
      const destStat = await fsp.stat(resolvedDestination).catch(() => null);
      if (!destStat || !destStat.isDirectory()) {
        throw new Error(WorkspaceError.invalidMove);
      }
    }

    const target = path.join(resolvedDestination, path.basename(resolvedSource));
    const exists = await fsp.stat(target).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }

    await fsp.cp(resolvedSource, target, { recursive: stat.isDirectory() });
    return normalizeRelativePath(path.relative(this.rootPath, target));
  }

  async deleteItem(relativePath) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolved = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }
    const manualRootPathBeforeDelete =
      this.rootFileInfo?.source === "manual" ? this.rootFileInfo.path : null;
    const normalizedTargetPath = normalizeRelativePath(trimmed);
    const restoreRootPath =
      manualRootPathBeforeDelete &&
      (manualRootPathBeforeDelete === normalizedTargetPath ||
        manualRootPathBeforeDelete.startsWith(`${normalizedTargetPath}/`))
        ? manualRootPathBeforeDelete
        : null;
    const affectsIndex = stat.isDirectory() || this.isIndexTarget(trimmed);

    const trashedPath = await this.moveToInternalTrash(resolved);
    this.undoStack.push({
      kind: "delete",
      fromPath: normalizeRelativePath(trimmed),
      toPath: null,
      isDirectory: stat.isDirectory(),
      affectsIndex,
      trashedPath,
      restoreRootPath,
    });
    await this.updateRootOverrideAfterDelete(trimmed);
  }

  async undoLastOperation() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const operation = this.undoStack.pop();
    if (!operation) {
      return null;
    }
    if (operation.kind === "move") {
      if (!operation.toPath) {
        throw new Error(WorkspaceError.invalidMove);
      }
      const source = this.resolvePath(operation.toPath);
      const target = this.resolvePath(operation.fromPath);
      const exists = await fsp.stat(target).then(() => true).catch(() => false);
      if (exists) {
        throw new Error(WorkspaceError.alreadyExists);
      }
      await ensureDirectory(path.dirname(target));
      await fsp.rename(source, target);
      this.updateRootOverrideAfterRename(operation.toPath, operation.fromPath);
      return operation;
    }
    if (operation.kind === "delete") {
      if (!operation.trashedPath) {
        throw new Error(WorkspaceError.invalidMove);
      }
      const target = this.resolvePath(operation.fromPath);
      const exists = await fsp.stat(target).then(() => true).catch(() => false);
      if (exists) {
        throw new Error(WorkspaceError.alreadyExists);
      }
      await ensureDirectory(path.dirname(target));
      await fsp.rename(operation.trashedPath, target);
      if (operation.restoreRootPath) {
        this.rootInfoRootPath = this.rootPath;
        this.rootFileInfo = { path: operation.restoreRootPath, source: "manual" };
        await this.updateSettings((settings) => {
          settings.rootFile = operation.restoreRootPath;
          return settings;
        }).catch(() => null);
      }
      return operation;
    }
    return null;
  }

  async initializeProject(rootPath, locale = "en") {
    await ensureDirectory(rootPath);
    const ensureUniqueMainPath = async () => {
      let index = 1;
      let candidate = path.join(rootPath, "main.tex");
      const exists = async (filePath) =>
        fsp
          .stat(filePath)
          .then((stat) => stat.isFile() || stat.isDirectory())
          .catch(() => false);
      while (await exists(candidate)) {
        index += 1;
        candidate = path.join(rootPath, `main${index}.tex`);
      }
      return candidate;
    };
    const mainTexPath = await ensureUniqueMainPath();
    const content = this.templateContent(locale);
    await writeUtf8File(mainTexPath, content);
  }

  templateContent(locale = "en") {
    return locale === "ja" ? TEMPLATE_LUALATEX_JA : TEMPLATE_LUALATEX_EN;
  }

  async detectRootFile() {
    if (!this.rootPath) {
      return null;
    }
    const mainCandidate = path.join(this.rootPath, "main.tex");
    const mainExists = await fsp
      .stat(mainCandidate)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (mainExists) {
      return "main.tex";
    }

    const candidates = [];
    await this.walkEntries({
      onFile: async (relativePath, absolutePath) => {
        if (path.extname(absolutePath).toLowerCase() !== ".tex") {
          return;
        }
        const content = await readUtf8File(absolutePath).catch(() => null);
        if (content === null) {
          return;
        }
        const lowerName = path.basename(absolutePath).toLowerCase();
        let score = 0;
        if (content.includes("\\documentclass")) {
          score += 3;
        }
        if (content.includes("\\begin{document}")) {
          score += 2;
        }
        if (content.includes("\\end{document}")) {
          score += 1;
        }
        if (
          [
            "main.tex",
            "root.tex",
            "paper.tex",
            "thesis.tex",
            "report.tex",
            "lecture.tex",
            "notes.tex",
          ].includes(lowerName)
        ) {
          score += 2;
        }
        if (score <= 0) {
          return;
        }
        const depth = normalizeRelativePath(relativePath).split("/").length;
        candidates.push({ path: normalizeRelativePath(relativePath), score, depth });
      },
    });

    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return a.path.localeCompare(b.path, "ja");
    });
    return candidates[0].path;
  }

  async resolveTexRootFromMagic(relativePath, options = {}) {
    if (!this.rootPath) {
      return null;
    }
    const maxDepth = Number.isFinite(options?.maxDepth)
      ? Math.max(1, Math.floor(options.maxDepth))
      : 5;
    const visited = new Set();
    let current = normalizeRelativePath(relativePath ?? "");
    let resolvedAtLeastOnce = false;

    for (let depth = 0; depth < maxDepth; depth += 1) {
      const token = current.toLowerCase();
      if (visited.has(token)) {
        return null;
      }
      visited.add(token);
      const absPath = this.resolvePath(current);
      const content = await readUtf8File(absPath).catch(() => null);
      if (content === null) {
        return null;
      }
      const magic = extractTexMagicRoot(content);
      if (!magic) {
        return resolvedAtLeastOnce ? current : null;
      }
      const baseDir = path.dirname(absPath);
      const candidates = [];
      candidates.push(magic);
      if (!path.extname(magic)) {
        candidates.push(`${magic}.tex`);
      }
      let next = null;
      for (const candidate of candidates) {
        const resolvedAbs = path.resolve(baseDir, candidate);
        const rootResolved = path.resolve(this.rootPath);
        if (resolvedAbs !== rootResolved && !resolvedAbs.startsWith(rootResolved + path.sep)) {
          continue;
        }
        const stat = await fsp.stat(resolvedAbs).catch(() => null);
        if (!stat || !stat.isFile()) {
          continue;
        }
        if (path.extname(resolvedAbs).toLowerCase() !== ".tex") {
          continue;
        }
        next = normalizeRelativePath(path.relative(this.rootPath, resolvedAbs));
        break;
      }
      if (!next) {
        return null;
      }
      resolvedAtLeastOnce = true;
      current = next;
    }
    return resolvedAtLeastOnce ? current : null;
  }

  async updateSettings(mutator) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const directory = path.join(this.rootPath, ".tex64");
    await ensureDirectory(directory);
    const settingsPath = path.join(directory, "settings.json");

    const exists = await fsp.stat(settingsPath).then(() => true).catch(() => false);
    let settings = {};
    if (exists) {
      settings = await readUtf8File(settingsPath)
        .then((raw) => JSON.parse(raw))
        .catch(() => ({}));
      if (!settings || typeof settings !== "object") {
        settings = {};
      }
    }

    const next = mutator(settings) ?? settings;
    const normalized = next && typeof next === "object" ? next : {};

    Object.keys(normalized).forEach((key) => {
      if (normalized[key] === undefined) {
        delete normalized[key];
      }
    });

    const keys = Object.keys(normalized);
    if (keys.length === 0) {
      await fsp.unlink(settingsPath).catch(() => null);
      return;
    }

    const payload = JSON.stringify(normalized, null, 2);
    await writeUtf8File(settingsPath, payload);
  }

  async loadSettings() {
    if (!this.rootPath) {
      return null;
    }
    const settingsPath = path.join(this.rootPath, ".tex64", "settings.json");
    const exists = await fsp.stat(settingsPath).then(() => true).catch(() => false);
    if (!exists) {
      return null;
    }
    const raw = await readUtf8File(settingsPath);
    return JSON.parse(raw);
  }

  async saveSettings(settings) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const directory = path.join(this.rootPath, ".tex64");
    await ensureDirectory(directory);
    const settingsPath = path.join(directory, "settings.json");
    const payload = JSON.stringify(settings, null, 2);
    await writeUtf8File(settingsPath, payload);
  }

  async removeSettings() {
    if (!this.rootPath) {
      return;
    }
    const settingsPath = path.join(this.rootPath, ".tex64", "settings.json");
    await fsp.unlink(settingsPath).catch(() => null);
  }

  updateRootOverrideAfterRename(oldPath, newPath) {
    if (!this.rootPath || this.rootInfoRootPath !== this.rootPath || !this.rootFileInfo) {
      return;
    }
    if (this.rootFileInfo.source !== "manual") {
      return;
    }
    const currentRoot = this.rootFileInfo.path;
    const normalizedOld = normalizeRelativePath(oldPath);
    const normalizedNew = normalizeRelativePath(newPath);
    if (currentRoot === normalizedOld) {
      this.rootFileInfo = { path: normalizedNew, source: "manual" };
      this.updateSettings((settings) => {
        settings.rootFile = normalizedNew;
        return settings;
      }).catch(() => null);
      return;
    }
    const prefix = normalizedOld + "/";
    if (!currentRoot.startsWith(prefix)) {
      return;
    }
    const suffix = currentRoot.slice(prefix.length);
    const updatedPath = `${normalizedNew}/${suffix}`;
    this.rootFileInfo = { path: updatedPath, source: "manual" };
    this.updateSettings((settings) => {
      settings.rootFile = updatedPath;
      return settings;
    }).catch(() => null);
  }

  async updateRootOverrideAfterDelete(deletedPath) {
    if (!this.rootPath || this.rootInfoRootPath !== this.rootPath || !this.rootFileInfo) {
      return;
    }
    if (this.rootFileInfo.source !== "manual") {
      return;
    }
    const currentRoot = this.rootFileInfo.path;
    const normalizedDeleted = normalizeRelativePath(deletedPath);
    if (currentRoot === normalizedDeleted || currentRoot.startsWith(normalizedDeleted + "/")) {
      this.rootFileInfo = null;
      await this.updateSettings((settings) => {
        delete settings.rootFile;
        return settings;
      }).catch(() => null);
    }
  }

  isIndexTarget(relativePath) {
    const lower = normalizeRelativePath(relativePath).toLowerCase();
    return lower.endsWith(".tex") || lower.endsWith(".bib");
  }

  async moveToInternalTrash(itemPath) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trashDir = path.join(this.rootPath, ".tex64", ".trash");
    await ensureDirectory(trashDir);
    const baseName = path.basename(itemPath);
    let attempt = 0;
    let candidate = path.join(trashDir, `${generateId()}-${baseName}`);
    while (attempt < 5) {
      const exists = await fsp.stat(candidate).then(() => true).catch(() => false);
      if (!exists) {
        break;
      }
      attempt += 1;
      candidate = path.join(trashDir, `${generateId()}-${baseName}`);
    }
    const finalExists = await fsp.stat(candidate).then(() => true).catch(() => false);
    if (finalExists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await fsp.rename(itemPath, candidate);
    return candidate;
  }

  async walkEntries({ onFile, onDirectory, limit }) {
    if (!this.rootPath) {
      return;
    }
    const max = limit ?? Number.POSITIVE_INFINITY;
    const rootPath = path.resolve(this.rootPath);
    let count = 0;

    const walk = async (dirPath) => {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (count >= max) {
          return;
        }
        // Keep the file tree focused on TeX writing:
        // - Hide dot-directories (VCS internals, tool metadata, etc.)
        // - Show dotfiles because they can contain TeX-related config (.latexmkrc, .latexindent.yaml, etc.)
        // - Hide OS noise files.
        if (entry.isDirectory() && entry.name.startsWith(".")) {
          continue;
        }
        if (entry.isFile() && isIgnoredFile(entry.name)) {
          continue;
        }
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const absPath = path.join(dirPath, entry.name);
        const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
        if (entry.isDirectory()) {
          if (onDirectory) {
            await onDirectory(relPath, absPath);
            count += 1;
          }
          await walk(absPath);
        } else if (entry.isFile()) {
          if (onFile) {
            await onFile(relPath, absPath);
            count += 1;
          }
        }
      }
    };

    await walk(rootPath);
  }
}

module.exports = {
  WorkspaceManager,
  WorkspaceError,
  normalizeRelativePath,
};
