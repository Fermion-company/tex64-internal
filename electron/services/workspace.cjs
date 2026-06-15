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
const TEMPLATE_LUALATEX_ZH = String.raw`% !TEX program = lualatex
% !TEX root = main.tex
\documentclass[UTF8,a4paper,11pt,fontset=fandol]{ctexart}

% ---------- 版式与排版 ----------
\usepackage[margin=25mm]{geometry}
\usepackage{microtype}

% ---------- 数学 ----------
\usepackage{amsmath, amssymb, mathtools}
\usepackage{amsthm}

% ---------- 图表 ----------
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{subcaption}
\usepackage{xcolor}

% ---------- 列表、引用、代码 ----------
\usepackage{enumitem}
\usepackage{csquotes}
\usepackage{listings}

% ---------- 交叉引用与超链接（最后加载） ----------
\usepackage{hyperref}
\hypersetup{
  colorlinks=true,
  linkcolor=blue!60!black,
  urlcolor=blue!60!black,
  citecolor=blue!60!black,
}

% ---------- 定理环境 ----------
\theoremstyle{plain}
\newtheorem{theorem}{定理}[section]
\newtheorem{lemma}[theorem]{引理}
\newtheorem{proposition}[theorem]{命题}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{定义}
\newtheorem{example}[theorem]{例}
\theoremstyle{remark}
\newtheorem*{remark}{注}
\renewcommand{\proofname}{证明}

% ---------- 代码清单样式 ----------
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

% ---------- 自定义快捷命令 ----------
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}

\title{文档标题}
\author{作者姓名\\\small \texttt{your.email@example.com}}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
此处填写文档摘要。用 2 至 3 句话说明问题、方法以及主要结论。
\end{abstract}

\tableofcontents
\bigskip

\section{引言}
\label{sec:intro}

正文以空行分段。可使用\emph{强调}与\textbf{粗体}。
脚注\footnote{脚注会显示在该页底部。}也可以自然地插入。

外部链接可直接给出: \url{https://example.org}，
也可以指定显示文字: \href{https://example.org}{示例站点}。

\section{数学}
\label{sec:math}

行内公式如 $a^2 + b^2 = c^2$ 自然地融入正文。
独立公式占据单独一行:
\begin{equation}
  \label{eq:euler}
  e^{i\pi} + 1 = 0.
\end{equation}
可以通过~\eqref{eq:euler}进行引用。

对齐的方程组:
\begin{align}
  (x + y)^2 &= x^2 + 2xy + y^2, \\
  (x - y)^2 &= x^2 - 2xy + y^2.
\end{align}

分段函数:
\begin{equation}
  \abs{x} =
  \begin{cases}
    x  & \text{若 } x \ge 0, \\
    -x & \text{其他情形.}
  \end{cases}
\end{equation}

矩阵:
\begin{equation}
  A =
  \begin{pmatrix}
    a_{11} & a_{12} \\
    a_{21} & a_{22}
  \end{pmatrix},
  \qquad
  \det A = a_{11} a_{22} - a_{12} a_{21}.
\end{equation}

\subsection{定理与证明}

\begin{definition}
  设 $f \colon \R \to \R$ 为函数。称 $f$ 在 $x_0 \in \R$ 处\emph{连续}，
  若对任意 $\varepsilon > 0$ 存在 $\delta > 0$，
  使得 $\abs{x - x_0} < \delta$ 时 $\abs{f(x) - f(x_0)} < \varepsilon$ 成立。
\end{definition}

\begin{theorem}[勾股定理]
  \label{thm:pythagoras}
  在两条直角边为 $a$、$b$，斜边为 $c$ 的直角三角形中，
  \[
    a^2 + b^2 = c^2.
  \]
\end{theorem}

\begin{proof}
  此处略，参见任何标准教材~\cite{euclid}。
\end{proof}

\begin{remark}
  定理~\ref{thm:pythagoras} 可推广到内积空间下的高维情形。
\end{remark}

\section{列表、引用与代码}

\subsection{列表}

无序列表:
\begin{itemize}
  \item 第一项。
  \item 第二项，可嵌套子列表:
  \begin{itemize}
    \item 嵌套项。
  \end{itemize}
\end{itemize}

带自定义标签的有序列表:
\begin{enumerate}[label=(\alph*)]
  \item 第一步。
  \item 第二步。
\end{enumerate}

描述列表:
\begin{description}
  \item[定义域] 输入的集合。
  \item[陪域] 可能的输出集合。
\end{description}

\subsection{块引用}

\begin{displayquote}
  数学是上帝用来书写宇宙的语言。
  \hfill --- 据传出自伽利略
\end{displayquote}

\subsection{代码清单}

\begin{lstlisting}[language=Python, caption={一个简短的例子。}, label={lst:example}]
def fib(n):
    """返回第 n 个斐波那契数。"""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{lstlisting}

清单~\ref{lst:example} 给出了一个迭代版本的辅助函数。

\section{图与表}

\subsection{单张图}

\begin{figure}[ht]
  \centering
  % \includegraphics[width=0.6\linewidth]{example}
  \fbox{\rule{0pt}{6em}\rule{0.6\linewidth}{0pt}}
  \caption{请将上方的占位符替换为 \texttt{\textbackslash includegraphics}。}
  \label{fig:example}
\end{figure}

\subsection{并排子图}

\begin{figure}[ht]
  \centering
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{左侧子图。}
    \label{fig:left}
  \end{subfigure}\hfill
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{右侧子图。}
    \label{fig:right}
  \end{subfigure}
  \caption{由两张子图组成的图。}
  \label{fig:subs}
\end{figure}

参见图~\ref{fig:example}，以及图~\ref{fig:subs}
的两个分图（\subref{fig:left} 与 \subref{fig:right}）。

\subsection{表格}

\begin{table}[ht]
  \centering
  \caption{booktabs 风格的表。}
  \label{tab:example}
  \begin{tabular}{lrr}
    \toprule
    项目     & 数量 & 平均 (秒) \\
    \midrule
    方法 A   &  120 & 0.42 \\
    方法 B   &   85 & 0.31 \\
    方法 C   &  210 & 0.58 \\
    \midrule
    合计     &  415 & 0.44 \\
    \bottomrule
  \end{tabular}
\end{table}

表~\ref{tab:example} 总结了三种方法的对比。

\section{结论}

请总结主要贡献并展望今后的工作。

\section*{致谢}

感谢支撑 LaTeX 生态的开源社区。

\begin{thebibliography}{9}
  \bibitem{euclid}
    Euclid, \emph{Elements}, ca.\ 300 BCE.
  \bibitem{knuth1984}
    D.~E.\ Knuth, \emph{The \TeX book}, Addison--Wesley, 1984.
\end{thebibliography}

\end{document}
`;

const TEMPLATE_LUALATEX_KO = String.raw`% !TEX program = lualatex
% !TEX root = main.tex
\documentclass[a4paper,11pt]{article}
\usepackage{kotex}

% ---------- 레이아웃 및 타이포그래피 ----------
\usepackage[margin=25mm]{geometry}
\usepackage{microtype}

% ---------- 수식 ----------
\usepackage{amsmath, amssymb, mathtools}
\usepackage{amsthm}

% ---------- 그림과 표 ----------
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{subcaption}
\usepackage{xcolor}

% ---------- 목록·인용·코드 ----------
\usepackage{enumitem}
\usepackage{csquotes}
\usepackage{listings}

% ---------- 상호 참조 및 링크 (마지막에 로드) ----------
\usepackage{hyperref}
\hypersetup{
  colorlinks=true,
  linkcolor=blue!60!black,
  urlcolor=blue!60!black,
  citecolor=blue!60!black,
}

% ---------- 정리 환경 ----------
\theoremstyle{plain}
\newtheorem{theorem}{정리}[section]
\newtheorem{lemma}[theorem]{보조정리}
\newtheorem{proposition}[theorem]{명제}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{정의}
\newtheorem{example}[theorem]{예}
\theoremstyle{remark}
\newtheorem*{remark}{비고}
\renewcommand{\proofname}{증명}

% ---------- 코드 리스팅 스타일 ----------
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

% ---------- 사용자 정의 단축 명령 ----------
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}

\title{문서 제목}
\author{작성자 이름\\\small \texttt{your.email@example.com}}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
여기에 문서 요약을 적습니다. 문제, 접근 방식, 핵심 결과를 두세 문장으로 정리하세요.
\end{abstract}

\tableofcontents
\bigskip

\section{서론}
\label{sec:intro}

본문은 빈 줄로 단락을 구분합니다. \emph{강조}나 \textbf{굵은 글씨}도 사용할 수 있습니다.
각주\footnote{각주는 페이지 하단에 표시됩니다.}도 자연스럽게 다룰 수 있습니다.

외부 링크는 그대로 붙여 넣을 수 있습니다: \url{https://example.org}.
대체 표시 텍스트도 가능합니다: \href{https://example.org}{예시 사이트}.

\section{수학}
\label{sec:math}

본문 안의 수식은 $a^2 + b^2 = c^2$ 와 같이 자연스럽게 흐릅니다.
별도 줄에 표시되는 수식도 있습니다:
\begin{equation}
  \label{eq:euler}
  e^{i\pi} + 1 = 0.
\end{equation}
식~\eqref{eq:euler} 와 같이 참조할 수 있습니다.

정렬된 수식:
\begin{align}
  (x + y)^2 &= x^2 + 2xy + y^2, \\
  (x - y)^2 &= x^2 - 2xy + y^2.
\end{align}

경우 분석:
\begin{equation}
  \abs{x} =
  \begin{cases}
    x  & (x \ge 0 \text{ 일 때}), \\
    -x & (\text{그 밖의 경우}).
  \end{cases}
\end{equation}

행렬:
\begin{equation}
  A =
  \begin{pmatrix}
    a_{11} & a_{12} \\
    a_{21} & a_{22}
  \end{pmatrix},
  \qquad
  \det A = a_{11} a_{22} - a_{12} a_{21}.
\end{equation}

\subsection{정리와 증명}

\begin{definition}
  함수 $f \colon \R \to \R$ 가 점 $x_0 \in \R$ 에서 \emph{연속}이라 함은,
  임의의 $\varepsilon > 0$ 에 대해 어떤 $\delta > 0$ 가 존재하여
  $\abs{x - x_0} < \delta$ 이면 $\abs{f(x) - f(x_0)} < \varepsilon$ 을 만족함을 말한다.
\end{definition}

\begin{theorem}[피타고라스의 정리]
  \label{thm:pythagoras}
  두 변의 길이가 $a$, $b$ 이고 빗변의 길이가 $c$ 인 직각삼각형에서,
  \[
    a^2 + b^2 = c^2.
  \]
\end{theorem}

\begin{proof}
  여기서는 생략한다. 표준적인 참고문헌~\cite{euclid} 을 참고하기 바란다.
\end{proof}

\begin{remark}
  정리~\ref{thm:pythagoras} 는 내적 공간에서의 고차원 일반화로 확장된다.
\end{remark}

\section{목록·인용·코드}

\subsection{목록}

순서 없는 목록:
\begin{itemize}
  \item 첫 번째 항목.
  \item 두 번째 항목, 중첩 목록을 포함:
  \begin{itemize}
    \item 중첩된 항목.
  \end{itemize}
\end{itemize}

레이블을 변경한 번호 매김 목록:
\begin{enumerate}[label=(\alph*)]
  \item 단계 1.
  \item 단계 2.
\end{enumerate}

설명 목록:
\begin{description}
  \item[정의역] 입력 값의 집합.
  \item[공역] 가능한 출력 값의 집합.
\end{description}

\subsection{블록 인용}

\begin{displayquote}
  수학은 신이 우주를 기록한 언어이다.
  \hfill --- 갈릴레오 갈릴레이(전언)
\end{displayquote}

\subsection{코드 리스팅}

\begin{lstlisting}[language=Python, caption={간단한 예.}, label={lst:example}]
def fib(n):
    """n번째 피보나치 수를 반환한다."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{lstlisting}

리스팅~\ref{lst:example} 은 반복 방식의 보조 함수를 보여 준다.

\section{그림과 표}

\subsection{한 개의 그림}

\begin{figure}[ht]
  \centering
  % \includegraphics[width=0.6\linewidth]{example}
  \fbox{\rule{0pt}{6em}\rule{0.6\linewidth}{0pt}}
  \caption{위의 자리표시자를 \texttt{\textbackslash includegraphics} 로 교체하세요.}
  \label{fig:example}
\end{figure}

\subsection{나란히 배치한 부분 그림}

\begin{figure}[ht]
  \centering
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{왼쪽 부분 그림.}
    \label{fig:left}
  \end{subfigure}\hfill
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{오른쪽 부분 그림.}
    \label{fig:right}
  \end{subfigure}
  \caption{두 부분 그림으로 이루어진 그림.}
  \label{fig:subs}
\end{figure}

그림~\ref{fig:example} 과 그림~\ref{fig:subs}
의 두 패널(\subref{fig:left}, \subref{fig:right})을 참조하세요.

\subsection{표}

\begin{table}[ht]
  \centering
  \caption{booktabs 스타일의 표.}
  \label{tab:example}
  \begin{tabular}{lrr}
    \toprule
    항목     & 건수 & 평균 (초) \\
    \midrule
    방법 A   &  120 & 0.42 \\
    방법 B   &   85 & 0.31 \\
    방법 C   &  210 & 0.58 \\
    \midrule
    합계     &  415 & 0.44 \\
    \bottomrule
  \end{tabular}
\end{table}

표~\ref{tab:example} 은 세 가지 방법을 비교한다.

\section{결론}

주요 기여를 요약하고 향후 과제를 제시합니다.

\section*{감사의 글}

LaTeX 생태계를 지탱하는 오픈소스 커뮤니티에 감사드립니다.

\begin{thebibliography}{9}
  \bibitem{euclid}
    Euclid, \emph{Elements}, ca.\ 300 BCE.
  \bibitem{knuth1984}
    D.~E.\ Knuth, \emph{The \TeX book}, Addison--Wesley, 1984.
\end{thebibliography}

\end{document}
`;

const TEMPLATE_LUALATEX_DE = String.raw`% !TEX program = lualatex
% !TEX root = main.tex
\documentclass[a4paper,11pt]{article}
\usepackage[ngerman]{babel}

% ---------- Layout & Typografie ----------
\usepackage[margin=25mm]{geometry}
\usepackage{microtype}
\usepackage{lmodern}

% ---------- Mathematik ----------
\usepackage{amsmath, amssymb, mathtools}
\usepackage{amsthm}

% ---------- Abbildungen & Tabellen ----------
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{subcaption}
\usepackage{xcolor}

% ---------- Listen, Zitate, Code ----------
\usepackage{enumitem}
\usepackage{csquotes}
\usepackage{listings}

% ---------- Querverweise & Hyperlinks (zuletzt laden) ----------
\usepackage{hyperref}
\hypersetup{
  colorlinks=true,
  linkcolor=blue!60!black,
  urlcolor=blue!60!black,
  citecolor=blue!60!black,
}

% ---------- Theorem-Umgebungen ----------
\theoremstyle{plain}
\newtheorem{theorem}{Satz}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{proposition}[theorem]{Proposition}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}
\newtheorem{example}[theorem]{Beispiel}
\theoremstyle{remark}
\newtheorem*{remark}{Bemerkung}

% ---------- Listings-Stil ----------
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

% ---------- Eigene Kurzbefehle ----------
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}

\title{Dokumenttitel}
\author{Ihr Name\\\small \texttt{your.email@example.com}}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Hier steht eine kurze Zusammenfassung des Dokuments. Beschreiben Sie das
Problem, Ihren Ansatz und das Hauptergebnis in zwei oder drei Saetzen.
\end{abstract}

\tableofcontents
\bigskip

\section{Einleitung}
\label{sec:intro}

Schreiben Sie den Text in Absaetzen, getrennt durch Leerzeilen.
Verwenden Sie \emph{Hervorhebung} und \textbf{Fettdruck} zur Betonung.
Fussnoten\footnote{Fussnoten erscheinen am Seitenende.} sind unkompliziert.

Externe Links sind klickbar: \url{https://example.org}, oder mit
eigenem Linktext: \href{https://example.org}{Beispielseite}.

\section{Mathematik}
\label{sec:math}

Mathematik im Fliesstext wie $a^2 + b^2 = c^2$ fuegt sich nahtlos ein.
Abgesetzte Formeln bekommen eine eigene Zeile:
\begin{equation}
  \label{eq:euler}
  e^{i\pi} + 1 = 0.
\end{equation}
Auf~\eqref{eq:euler} kann nach Bedarf verwiesen werden.

Ausgerichtete Gleichungen:
\begin{align}
  (x + y)^2 &= x^2 + 2xy + y^2, \\
  (x - y)^2 &= x^2 - 2xy + y^2.
\end{align}

Fallunterscheidung:
\begin{equation}
  \abs{x} =
  \begin{cases}
    x  & \text{falls } x \ge 0, \\
    -x & \text{sonst.}
  \end{cases}
\end{equation}

Matrizen:
\begin{equation}
  A =
  \begin{pmatrix}
    a_{11} & a_{12} \\
    a_{21} & a_{22}
  \end{pmatrix},
  \qquad
  \det A = a_{11} a_{22} - a_{12} a_{21}.
\end{equation}

\subsection{Saetze und Beweise}

\begin{definition}
  Sei $f \colon \R \to \R$ eine Funktion. $f$ heisst an der Stelle
  $x_0 \in \R$ \emph{stetig}, falls fuer jedes $\varepsilon > 0$ ein
  $\delta > 0$ existiert mit
  $\abs{x - x_0} < \delta \Rightarrow \abs{f(x) - f(x_0)} < \varepsilon$.
\end{definition}

\begin{theorem}[Satz des Pythagoras]
  \label{thm:pythagoras}
  In einem rechtwinkligen Dreieck mit Katheten $a$, $b$ und Hypotenuse $c$ gilt
  \[
    a^2 + b^2 = c^2.
  \]
\end{theorem}

\begin{proof}
  Hier ohne Beweis; siehe ein beliebiges Standardwerk~\cite{euclid}.
\end{proof}

\begin{remark}
  Satz~\ref{thm:pythagoras} laesst sich ueber innere Produktraeume auf
  hoehere Dimensionen uebertragen.
\end{remark}

\section{Listen, Zitate und Code}

\subsection{Listen}

Eine Aufzaehlung mit Punkten:
\begin{itemize}
  \item Erster Punkt.
  \item Zweiter Punkt mit verschachtelter Liste:
  \begin{itemize}
    \item Verschachtelter Punkt.
  \end{itemize}
\end{itemize}

Eine nummerierte Liste mit eigenen Markierungen:
\begin{enumerate}[label=(\alph*)]
  \item Schritt eins.
  \item Schritt zwei.
\end{enumerate}

Eine Beschreibungsliste:
\begin{description}
  \item[Definitionsbereich] Die Menge der Eingaben.
  \item[Wertebereich] Die Menge der moeglichen Ausgaben.
\end{description}

\subsection{Block-Zitat}

\begin{displayquote}
  Die Mathematik ist die Sprache, in der Gott das Universum geschrieben hat.
  \hfill --- Galileo Galilei (zugeschrieben)
\end{displayquote}

\subsection{Code-Listing}

\begin{lstlisting}[language=Python, caption={Ein kurzes Beispiel.}, label={lst:example}]
def fib(n):
    """Liefert die n-te Fibonacci-Zahl."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{lstlisting}

Listing~\ref{lst:example} zeigt eine iterative Hilfsfunktion.

\section{Abbildungen und Tabellen}

\subsection{Eine einzelne Abbildung}

\begin{figure}[ht]
  \centering
  % \includegraphics[width=0.6\linewidth]{example}
  \fbox{\rule{0pt}{6em}\rule{0.6\linewidth}{0pt}}
  \caption{Ersetzen Sie den Platzhalter oben durch \texttt{\textbackslash includegraphics}.}
  \label{fig:example}
\end{figure}

\subsection{Nebeneinander stehende Teilabbildungen}

\begin{figure}[ht]
  \centering
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{Linke Teilabbildung.}
    \label{fig:left}
  \end{subfigure}\hfill
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{Rechte Teilabbildung.}
    \label{fig:right}
  \end{subfigure}
  \caption{Eine Abbildung aus zwei Teilabbildungen.}
  \label{fig:subs}
\end{figure}

Siehe Abbildung~\ref{fig:example} und die Teile in Abbildung~\ref{fig:subs}
(\subref{fig:left} und \subref{fig:right}).

\subsection{Eine Tabelle}

\begin{table}[ht]
  \centering
  \caption{Eine Tabelle im booktabs-Stil.}
  \label{tab:example}
  \begin{tabular}{lrr}
    \toprule
    Eintrag    & Anzahl & Mittel (s) \\
    \midrule
    Methode A &    120 & 0,42 \\
    Methode B &     85 & 0,31 \\
    Methode C &    210 & 0,58 \\
    \midrule
    Summe     &    415 & 0,44 \\
    \bottomrule
  \end{tabular}
\end{table}

Tabelle~\ref{tab:example} fasst die drei Methoden zusammen.

\section{Fazit}

Fassen Sie Ihre Beitraege zusammen und skizzieren Sie weiterfuehrende Arbeiten.

\section*{Danksagung}

Der Autor dankt der Open-Source-Community fuer das LaTeX-Oekosystem.

\begin{thebibliography}{9}
  \bibitem{euclid}
    Euklid, \emph{Elemente}, ca.\ 300 v.\,Chr.
  \bibitem{knuth1984}
    D.~E.\ Knuth, \emph{The \TeX book}, Addison--Wesley, 1984.
\end{thebibliography}

\end{document}
`;

const TEMPLATE_LUALATEX_FR = String.raw`% !TEX program = lualatex
% !TEX root = main.tex
\documentclass[a4paper,11pt]{article}
\usepackage[french]{babel}

% ---------- Mise en page et typographie ----------
\usepackage[margin=25mm]{geometry}
\usepackage{microtype}
\usepackage{lmodern}

% ---------- Mathematiques ----------
\usepackage{amsmath, amssymb, mathtools}
\usepackage{amsthm}

% ---------- Figures et tableaux ----------
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{subcaption}
\usepackage{xcolor}

% ---------- Listes, citations, code ----------
\usepackage{enumitem}
\usepackage{csquotes}
\usepackage{listings}

% ---------- Renvois et liens (a charger en dernier) ----------
\usepackage{hyperref}
\hypersetup{
  colorlinks=true,
  linkcolor=blue!60!black,
  urlcolor=blue!60!black,
  citecolor=blue!60!black,
}

% ---------- Environnements de theoremes ----------
\theoremstyle{plain}
\newtheorem{theorem}{Theoreme}[section]
\newtheorem{lemma}[theorem]{Lemme}
\newtheorem{proposition}[theorem]{Proposition}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}
\newtheorem{example}[theorem]{Exemple}
\theoremstyle{remark}
\newtheorem*{remark}{Remarque}
\renewcommand{\proofname}{Demonstration}

% ---------- Style des listings ----------
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

% ---------- Raccourcis personnels ----------
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}

\title{Titre du document}
\author{Votre nom\\\small \texttt{your.email@example.com}}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Un bref resume du document figure ici. Enoncez le probleme, votre approche
et le resultat principal en deux ou trois phrases.
\end{abstract}

\tableofcontents
\bigskip

\section{Introduction}
\label{sec:intro}

Redigez votre texte en paragraphes separes par des lignes vides.
Utilisez l'\emph{italique} pour insister et le \textbf{gras} pour
appuyer fortement. Les notes\footnote{Les notes apparaissent en bas de page.}
sont simples a inserer.

Les liens externes sont cliquables : \url{https://example.org}, ou avec
un texte personnalise : \href{https://example.org}{site exemple}.

\section{Mathematiques}
\label{sec:math}

Une formule en ligne comme $a^2 + b^2 = c^2$ s'integre au texte.
Une formule hors-ligne dispose de sa propre ligne :
\begin{equation}
  \label{eq:euler}
  e^{i\pi} + 1 = 0.
\end{equation}
On peut faire reference a~\eqref{eq:euler} en cas de besoin.

Equations alignees :
\begin{align}
  (x + y)^2 &= x^2 + 2xy + y^2, \\
  (x - y)^2 &= x^2 - 2xy + y^2.
\end{align}

Cas par cas :
\begin{equation}
  \abs{x} =
  \begin{cases}
    x  & \text{si } x \ge 0, \\
    -x & \text{sinon.}
  \end{cases}
\end{equation}

Matrices :
\begin{equation}
  A =
  \begin{pmatrix}
    a_{11} & a_{12} \\
    a_{21} & a_{22}
  \end{pmatrix},
  \qquad
  \det A = a_{11} a_{22} - a_{12} a_{21}.
\end{equation}

\subsection{Theoremes et demonstrations}

\begin{definition}
  Soit $f \colon \R \to \R$ une fonction. On dit que $f$ est
  \emph{continue} en $x_0 \in \R$ si pour tout $\varepsilon > 0$
  il existe $\delta > 0$ tel que
  $\abs{x - x_0} < \delta$ implique $\abs{f(x) - f(x_0)} < \varepsilon$.
\end{definition}

\begin{theorem}[Theoreme de Pythagore]
  \label{thm:pythagoras}
  Dans un triangle rectangle de cotes de l'angle droit $a$, $b$ et
  d'hypotenuse $c$,
  \[
    a^2 + b^2 = c^2.
  \]
\end{theorem}

\begin{proof}
  Omise ; voir n'importe quelle reference standard~\cite{euclid}.
\end{proof}

\begin{remark}
  Le theoreme~\ref{thm:pythagoras} s'etend en dimension superieure
  via les espaces prehilbertiens.
\end{remark}

\section{Listes, citations et code}

\subsection{Listes}

Une liste a puces :
\begin{itemize}
  \item Premier element.
  \item Deuxieme element, avec une liste imbriquee :
  \begin{itemize}
    \item Element imbrique.
  \end{itemize}
\end{itemize}

Une liste numerotee a etiquettes personnalisees :
\begin{enumerate}[label=(\alph*)]
  \item Etape un.
  \item Etape deux.
\end{enumerate}

Une liste de descriptions :
\begin{description}
  \item[Domaine] L'ensemble des entrees.
  \item[Codomaine] L'ensemble des sorties possibles.
\end{description}

\subsection{Citation en bloc}

\begin{displayquote}
  Les mathematiques sont le langage dans lequel Dieu a ecrit l'univers.
  \hfill --- attribue a Galilee
\end{displayquote}

\subsection{Listing de code}

\begin{lstlisting}[language=Python, caption={Un court exemple.}, label={lst:example}]
def fib(n):
    """Renvoie le n-ieme nombre de Fibonacci."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{lstlisting}

Le listing~\ref{lst:example} montre une variante iterative.

\section{Figures et tableaux}

\subsection{Une figure simple}

\begin{figure}[ht]
  \centering
  % \includegraphics[width=0.6\linewidth]{example}
  \fbox{\rule{0pt}{6em}\rule{0.6\linewidth}{0pt}}
  \caption{Remplacez l'espace reserve ci-dessus par \texttt{\textbackslash includegraphics}.}
  \label{fig:example}
\end{figure}

\subsection{Sous-figures cote a cote}

\begin{figure}[ht]
  \centering
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{Sous-figure de gauche.}
    \label{fig:left}
  \end{subfigure}\hfill
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{Sous-figure de droite.}
    \label{fig:right}
  \end{subfigure}
  \caption{Une figure composee de deux sous-figures.}
  \label{fig:subs}
\end{figure}

Voir la figure~\ref{fig:example} et les vignettes de la
figure~\ref{fig:subs} (\subref{fig:left} et \subref{fig:right}).

\subsection{Un tableau}

\begin{table}[ht]
  \centering
  \caption{Un tableau au style booktabs.}
  \label{tab:example}
  \begin{tabular}{lrr}
    \toprule
    Element    & Effectif & Moyenne (s) \\
    \midrule
    Methode A &      120 & 0,42 \\
    Methode B &       85 & 0,31 \\
    Methode C &      210 & 0,58 \\
    \midrule
    Total     &      415 & 0,44 \\
    \bottomrule
  \end{tabular}
\end{table}

Le tableau~\ref{tab:example} recapitule les trois methodes.

\section{Conclusion}

Resumez vos contributions et esquissez les pistes pour la suite.

\section*{Remerciements}

L'auteur remercie la communaute open source pour l'ecosysteme LaTeX.

\begin{thebibliography}{9}
  \bibitem{euclid}
    Euclide, \emph{Elements}, vers 300 av.\,J.-C.
  \bibitem{knuth1984}
    D.~E.\ Knuth, \emph{The \TeX book}, Addison--Wesley, 1984.
\end{thebibliography}

\end{document}
`;

const TEMPLATE_LUALATEX_ES = String.raw`% !TEX program = lualatex
% !TEX root = main.tex
\documentclass[a4paper,11pt]{article}
\usepackage[spanish]{babel}

% ---------- Diseno y tipografia ----------
\usepackage[margin=25mm]{geometry}
\usepackage{microtype}
\usepackage{lmodern}

% ---------- Matematicas ----------
\usepackage{amsmath, amssymb, mathtools}
\usepackage{amsthm}

% ---------- Figuras y tablas ----------
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{subcaption}
\usepackage{xcolor}

% ---------- Listas, citas, codigo ----------
\usepackage{enumitem}
\usepackage{csquotes}
\usepackage{listings}

% ---------- Referencias cruzadas e hipervinculos (cargar al final) ----------
\usepackage{hyperref}
\hypersetup{
  colorlinks=true,
  linkcolor=blue!60!black,
  urlcolor=blue!60!black,
  citecolor=blue!60!black,
}

% ---------- Entornos de teorema ----------
\theoremstyle{plain}
\newtheorem{theorem}{Teorema}[section]
\newtheorem{lemma}[theorem]{Lema}
\newtheorem{proposition}[theorem]{Proposicion}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definicion}
\newtheorem{example}[theorem]{Ejemplo}
\theoremstyle{remark}
\newtheorem*{remark}{Observacion}

% ---------- Estilo de listings ----------
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

% ---------- Atajos personalizados ----------
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}

\title{Titulo del documento}
\author{Tu nombre\\\small \texttt{your.email@example.com}}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Aqui va un breve resumen del documento. Plantea el problema, tu enfoque
y el resultado principal en dos o tres frases.
\end{abstract}

\tableofcontents
\bigskip

\section{Introduccion}
\label{sec:intro}

Escribe el texto en parrafos separados por lineas en blanco.
Usa la \emph{cursiva} para enfatizar y la \textbf{negrita} para realzar.
Las notas\footnote{Las notas aparecen al pie de la pagina.} son sencillas.

Los enlaces externos son interactivos: \url{https://example.org}, o con
un texto personalizado: \href{https://example.org}{sitio de ejemplo}.

\section{Matematicas}
\label{sec:math}

Una formula en linea como $a^2 + b^2 = c^2$ se integra con el texto.
Las formulas en bloque ocupan su propia linea:
\begin{equation}
  \label{eq:euler}
  e^{i\pi} + 1 = 0.
\end{equation}
Se puede hacer referencia con~\eqref{eq:euler} cuando convenga.

Ecuaciones alineadas:
\begin{align}
  (x + y)^2 &= x^2 + 2xy + y^2, \\
  (x - y)^2 &= x^2 - 2xy + y^2.
\end{align}

Casos:
\begin{equation}
  \abs{x} =
  \begin{cases}
    x  & \text{si } x \ge 0, \\
    -x & \text{en otro caso.}
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

\subsection{Teoremas y demostraciones}

\begin{definition}
  Sea $f \colon \R \to \R$ una funcion. Se dice que $f$ es
  \emph{continua} en $x_0 \in \R$ si para cada $\varepsilon > 0$
  existe $\delta > 0$ tal que
  $\abs{x - x_0} < \delta$ implica $\abs{f(x) - f(x_0)} < \varepsilon$.
\end{definition}

\begin{theorem}[Teorema de Pitagoras]
  \label{thm:pythagoras}
  En un triangulo rectangulo con catetos $a$, $b$ e hipotenusa $c$,
  \[
    a^2 + b^2 = c^2.
  \]
\end{theorem}

\begin{proof}
  Se omite; vease cualquier referencia estandar~\cite{euclid}.
\end{proof}

\begin{remark}
  El teorema~\ref{thm:pythagoras} se generaliza a dimensiones superiores
  mediante espacios con producto interno.
\end{remark}

\section{Listas, citas y codigo}

\subsection{Listas}

Una lista con vinetas:
\begin{itemize}
  \item Primer elemento.
  \item Segundo elemento, con una lista anidada:
  \begin{itemize}
    \item Elemento anidado.
  \end{itemize}
\end{itemize}

Una lista numerada con etiquetas personalizadas:
\begin{enumerate}[label=(\alph*)]
  \item Paso uno.
  \item Paso dos.
\end{enumerate}

Una lista de descripciones:
\begin{description}
  \item[Dominio] El conjunto de entradas.
  \item[Codominio] El conjunto de posibles salidas.
\end{description}

\subsection{Cita en bloque}

\begin{displayquote}
  Las matematicas son el lenguaje en que Dios ha escrito el universo.
  \hfill --- atribuido a Galileo
\end{displayquote}

\subsection{Listado de codigo}

\begin{lstlisting}[language=Python, caption={Un ejemplo breve.}, label={lst:example}]
def fib(n):
    """Devuelve el n-esimo numero de Fibonacci."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{lstlisting}

El listado~\ref{lst:example} muestra una version iterativa.

\section{Figuras y tablas}

\subsection{Una figura simple}

\begin{figure}[ht]
  \centering
  % \includegraphics[width=0.6\linewidth]{example}
  \fbox{\rule{0pt}{6em}\rule{0.6\linewidth}{0pt}}
  \caption{Sustituye el marcador de arriba por \texttt{\textbackslash includegraphics}.}
  \label{fig:example}
\end{figure}

\subsection{Subfiguras lado a lado}

\begin{figure}[ht]
  \centering
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{Subfigura izquierda.}
    \label{fig:left}
  \end{subfigure}\hfill
  \begin{subfigure}[t]{0.45\linewidth}
    \centering
    \fbox{\rule{0pt}{4em}\rule{0.9\linewidth}{0pt}}
    \caption{Subfigura derecha.}
    \label{fig:right}
  \end{subfigure}
  \caption{Una figura compuesta por dos subfiguras.}
  \label{fig:subs}
\end{figure}

Vease la figura~\ref{fig:example} y los paneles de la
figura~\ref{fig:subs} (\subref{fig:left} y \subref{fig:right}).

\subsection{Una tabla}

\begin{table}[ht]
  \centering
  \caption{Una tabla con estilo booktabs.}
  \label{tab:example}
  \begin{tabular}{lrr}
    \toprule
    Elemento  & Conteo & Media (s) \\
    \midrule
    Metodo A &    120 & 0,42 \\
    Metodo B &     85 & 0,31 \\
    Metodo C &    210 & 0,58 \\
    \midrule
    Total    &    415 & 0,44 \\
    \bottomrule
  \end{tabular}
\end{table}

La tabla~\ref{tab:example} resume los tres metodos.

\section{Conclusion}

Resume tus aportaciones y esboza el trabajo futuro.

\section*{Agradecimientos}

El autor agradece a la comunidad de software libre por el ecosistema LaTeX.

\begin{thebibliography}{9}
  \bibitem{euclid}
    Euclides, \emph{Elementos}, ca.\ 300 a.\,C.
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
    const map = {
      ja: TEMPLATE_LUALATEX_JA,
      en: TEMPLATE_LUALATEX_EN,
      zh: TEMPLATE_LUALATEX_ZH,
      ko: TEMPLATE_LUALATEX_KO,
      de: TEMPLATE_LUALATEX_DE,
      fr: TEMPLATE_LUALATEX_FR,
      es: TEMPLATE_LUALATEX_ES,
    };
    return map[locale] || TEMPLATE_LUALATEX_EN;
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
