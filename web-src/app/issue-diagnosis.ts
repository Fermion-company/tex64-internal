import { uiText } from "./i18n.js";
import { getIssueResolution } from "./issue-resolution.js";
import type { IssueItem } from "./types.js";

/**
 * A build issue, said in plain language.
 *
 * The raw log line is for people who already read TeX logs; everyone else gets
 * three short pieces: what family of problem this is, what actually happened,
 * and what to do about it. The log stays one disclosure click away.
 */
export type IssueDiagnosis = {
  /** What family of problem this is, e.g. "Missing file". */
  kind: string;
  /** One sentence, no TeX jargon, describing what went wrong. */
  summary: string;
  /** One sentence telling the reader what to change. */
  fix: string;
};

type Rule = {
  id: string;
  pattern: RegExp;
  // Lazy so the strings resolve in the locale that is active at render time,
  // not the one that happened to be set when this module was imported.
  kind: (m: RegExpMatchArray) => string;
  summary: (m: RegExpMatchArray) => string;
  fix: (m: RegExpMatchArray) => string;
};

/** Strips the log's own punctuation so a message reads like a sentence. */
export const cleanIssueMessage = (message: string) =>
  message
    .trim()
    .replace(/^!\s*/, "")
    .replace(/^(?:LaTeX|pdfTeX|LuaTeX|XeTeX)\s+(?:Error|Warning):\s*/i, "")
    .trim();

const isStyleFile = (name: string) => /\.(sty|cls|def|cfg|clo|fd|ldf)$/i.test(name);

// Ordered: the first match wins, so keep the specific patterns above the
// general ones (a "Package xyz Error" line must not be eaten by the catch-all).
const rules: Rule[] = [
  {
    id: "file-not-found",
    pattern: /File\s+[`'"]([^`'"]+)['"]?\s+not found/i,
    kind: () => uiText("Missing file", "ファイルが見つかりません"),
    summary: (m) =>
      uiText(`LaTeX could not find ${m[1]}.`, `${m[1]} を読み込めませんでした。`),
    fix: (m) =>
      isStyleFile(m[1])
        ? uiText(
            "That file comes from a package. Open Settings > Environment and update the TeX distribution, then build again.",
            "これはパッケージに含まれるファイルです。設定 > 環境 で TeX 環境を更新してから、もう一度ビルドしてください。"
          )
        : uiText(
            "Check the spelling of the name and that the file sits where the document expects it.",
            "ファイル名のつづりと、文書から見た置き場所（相対パス）を確認してください。"
          ),
  },
  {
    id: "unicode-not-set-up",
    pattern: /Unicode character[^\n]*not set up for use with LaTeX/i,
    kind: () => uiText("Character not supported", "この文字を出力できません"),
    summary: () =>
      uiText(
        "The current document setup cannot typeset this character.",
        "今の文書設定では、この文字（日本語など）を出力できません。"
      ),
    fix: () =>
      uiText(
        "For Japanese use luatexja or ltjsarticle, for Chinese ctex, for Korean kotex; otherwise load fontspec with a font that has the character.",
        "日本語なら luatexja / ltjsarticle、中国語なら ctex、韓国語なら kotex、それ以外は fontspec で該当文字を持つフォントを指定してください。"
      ),
  },
  {
    id: "missing-glyph",
    pattern: /^The PDF cannot display the character/i,
    kind: () => uiText("Font has no such character", "フォントに文字がありません"),
    // The build service's own message already reads plainly; it just carries
    // the advice tail that belongs in `fix`, so cut it there.
    summary: (m) => (m.input ?? m[0]).split(/\s*Use a Unicode-aware/)[0].trim(),
    fix: () =>
      uiText(
        "Switch to a document class or font that covers the language, then build again.",
        "その言語に対応した文書クラス・フォントに切り替えてから、もう一度ビルドしてください。"
      ),
  },
  {
    id: "undefined-control-sequence",
    pattern: /Undefined control sequence/i,
    kind: () => uiText("Unknown command", "知らないコマンドです"),
    summary: (m) => {
      const name = m.input?.match(/\\([A-Za-z@]{2,})\s*$/);
      return name
        ? uiText(`LaTeX does not know the command \\${name[1]}.`, `\\${name[1]} というコマンドを LaTeX が知りません。`)
        : uiText(
            "LaTeX ran into a command it does not know.",
            "LaTeX が知らないコマンドが使われています。"
          );
    },
    fix: () =>
      uiText(
        "Check the spelling, and add the \\usepackage that provides the command to your preamble.",
        "つづりを確認し、そのコマンドを提供する \\usepackage をプリアンブルに追加してください。"
      ),
  },
  {
    id: "missing-begin-document",
    pattern: /Missing \\begin\{document\}/i,
    kind: () => uiText("Text before the document starts", "本文が始まる前に文章があります"),
    summary: () =>
      uiText(
        "Something above \\begin{document} is being typeset, but the preamble is for setup only.",
        "\\begin{document} より前に、出力される文章が書かれています。"
      ),
    fix: () =>
      uiText(
        "Move that text below \\begin{document}, and keep only \\usepackage and settings above it.",
        "その文章を \\begin{document} より後ろに移し、前には \\usepackage や設定だけを置いてください。"
      ),
  },
  {
    id: "missing-dollar",
    pattern: /Missing \$ inserted/i,
    kind: () => uiText("Math mode needed", "数式モードが必要です"),
    summary: () =>
      uiText(
        "A symbol that only works inside math is being used in ordinary text.",
        "数式の中でしか使えない記号（_ や ^ や \\alpha など）を本文で使っています。"
      ),
    fix: () =>
      uiText(
        "Wrap that part in $ ... $, or move it into a math environment.",
        "その部分を $ ... $ で囲むか、数式環境の中に入れてください。"
      ),
  },
  {
    id: "brace-mismatch",
    pattern: /Missing [{}] inserted|Extra [{}]|Too many \}'s/i,
    kind: () => uiText("Braces do not match", "括弧の対応が合っていません"),
    summary: () =>
      uiText(
        "The number of { and } does not add up.",
        "{ と } の数が合っていません。"
      ),
    fix: () =>
      uiText(
        "Check that every { on and around this line has its closing }.",
        "この行の前後で { と } が対になっているか確認してください。"
      ),
  },
  {
    id: "environment-mismatch",
    pattern: /\\begin\{([^}]+)\}(?:[^\n]*?)ended by \\end\{([^}]+)\}/i,
    kind: () => uiText("Environment does not close", "環境の開始と終了が食い違っています"),
    summary: (m) =>
      uiText(
        `\\begin{${m[1]}} is being closed by \\end{${m[2]}}.`,
        `\\begin{${m[1]}} が \\end{${m[2]}} で閉じられています。`
      ),
    fix: () =>
      uiText(
        "Make the \\begin and \\end names match, or fix the nesting order.",
        "\\begin と \\end の名前を揃えるか、入れ子の順序を直してください。"
      ),
  },
  {
    id: "environment-undefined",
    pattern: /Environment\s+([^\s]+)\s+undefined/i,
    kind: () => uiText("Unknown environment", "知らない環境です"),
    summary: (m) =>
      uiText(`LaTeX does not know the ${m[1]} environment.`, `${m[1]} 環境を LaTeX が知りません。`),
    fix: () =>
      uiText(
        "Check the spelling, and load the package that provides the environment with \\usepackage.",
        "つづりを確認し、その環境を提供するパッケージを \\usepackage で読み込んでください。"
      ),
  },
  {
    id: "option-clash",
    pattern: /Option clash for package\s+([^\s.]+)/i,
    kind: () => uiText("Conflicting package options", "パッケージのオプションが衝突しています"),
    summary: (m) =>
      uiText(
        `${m[1]} is loaded twice with different options.`,
        `${m[1]} を違うオプションで2回読み込んでいます。`
      ),
    fix: () =>
      uiText(
        "Load the package once, in one place, with a single set of options.",
        "\\usepackage を1か所にまとめ、オプションを1つに統一してください。"
      ),
  },
  {
    id: "command-already-defined",
    pattern: /Command\s+\\([A-Za-z@]+)\s+already defined/i,
    kind: () => uiText("Name already taken", "コマンド名が衝突しています"),
    summary: (m) =>
      uiText(`\\${m[1]} is already defined.`, `\\${m[1]} は既に定義されています。`),
    fix: () =>
      uiText(
        "Use \\renewcommand instead of \\newcommand, or pick another name.",
        "\\newcommand を \\renewcommand に変えるか、別の名前にしてください。"
      ),
  },
  {
    id: "runaway-argument",
    pattern: /Runaway argument|File ended while scanning use of|Paragraph ended before[^\n]*was complete/i,
    kind: () => uiText("Argument never closes", "引数が閉じられていません"),
    summary: () =>
      uiText(
        "A command's argument was left open when the paragraph or file ended.",
        "コマンドの引数が閉じないまま、段落かファイルが終わっています。"
      ),
    fix: () =>
      uiText(
        "Close the { } of the command just before this point, and remove any blank line inside its argument.",
        "直前のコマンドの { } を閉じ、引数の途中に空行が入っていないか確認してください。"
      ),
  },
  {
    id: "missing-number",
    pattern: /Missing number, treated as zero/i,
    kind: () => uiText("A number was expected", "数値が必要です"),
    summary: () =>
      uiText(
        "Something that needs a number or a length was given neither.",
        "数値や長さを書く場所に、数値がありません。"
      ),
    fix: () =>
      uiText(
        "Give a number, or a length with its unit such as 10pt.",
        "数値、または単位つきの長さ（例: 10pt）を指定してください。"
      ),
  },
  {
    id: "no-line-to-end",
    pattern: /There's no line here to end/i,
    kind: () => uiText("Stray line break", "改行コマンドの使い方が違います"),
    summary: () =>
      uiText(
        "\\\\ was used where there is no line to break.",
        "改行する行がない場所で \\\\ が使われています。"
      ),
    fix: () =>
      uiText(
        "Separate paragraphs with a blank line instead, or delete the \\\\.",
        "段落は空行で分け、その \\\\ は削除してください。"
      ),
  },
  {
    id: "citation-undefined",
    pattern: /Citation\s+[`'"]?([^`'"\s]+)['"]?\s+[^\n]*undefined/i,
    kind: () => uiText("Citation not resolved", "引用が未解決です"),
    summary: (m) =>
      uiText(`No bibliography entry was found for ${m[1]}.`, `${m[1]} の文献情報が見つかりません。`),
    fix: () =>
      uiText(
        "Check that the key exists in your .bib file, then build again — citations resolve on the second pass.",
        ".bib に同じキーがあるか確認し、もう一度ビルドしてください（引用は2回目のビルドで解決します）。"
      ),
  },
  {
    id: "reference-undefined",
    pattern: /Reference\s+[`'"]?([^`'"\s]+)['"]?\s+[^\n]*undefined/i,
    kind: () => uiText("Cross-reference not resolved", "相互参照が未解決です"),
    summary: (m) =>
      uiText(`No \\label named ${m[1]} was found.`, `${m[1]} というラベルが見つかりません。`),
    fix: () =>
      uiText(
        "Check the \\label spelling, then build again — references resolve on the second pass.",
        "\\label のつづりを確認し、もう一度ビルドしてください（参照は2回目のビルドで解決します）。"
      ),
  },
  {
    id: "label-multiply-defined",
    pattern: /Label\s+[`'"]?([^`'"\s]+)['"]?\s+[^\n]*multiply defined/i,
    kind: () => uiText("Duplicate label", "ラベルが重複しています"),
    summary: (m) =>
      uiText(`\\label{${m[1]}} is used more than once.`, `\\label{${m[1]}} が2か所以上で使われています。`),
    fix: () =>
      uiText(
        "Rename one of them so every label is unique.",
        "どちらかを別の名前にして、ラベルを一意にしてください。"
      ),
  },
  {
    id: "overfull-box",
    pattern: /^Overfull \\[hv]box/i,
    kind: () => uiText("Text runs past the margin", "行がはみ出しています"),
    summary: () =>
      uiText(
        "A line is slightly wider than the text area.",
        "本文が版面の幅を少しはみ出しています。"
      ),
    fix: () =>
      uiText(
        "Usually safe to ignore. To remove it, reword the line, add a hyphenation point, or allow looser spacing.",
        "たいていは無視して構いません。気になるときは言い換え・ハイフン位置の指定・行間の許容を試してください。"
      ),
  },
  {
    id: "underfull-box",
    pattern: /^Underfull \\[hv]box/i,
    kind: () => uiText("Loose spacing", "行間・字間が間延びしています"),
    summary: () =>
      uiText(
        "A line was stretched to fill the width.",
        "幅を埋めるために字間や行間が引き伸ばされています。"
      ),
    fix: () =>
      uiText("Usually safe to ignore.", "たいていは無視して構いません。"),
  },
  {
    id: "emergency-stop",
    pattern: /Emergency stop|Fatal error occurred/i,
    kind: () => uiText("Build gave up", "処理が中断しました"),
    summary: () =>
      uiText(
        "LaTeX stopped because of an earlier error, not because of this line.",
        "先に出ている別のエラーが原因で、LaTeX が処理を打ち切りました。"
      ),
    fix: () =>
      uiText(
        "Fix the first error in this list, then build again.",
        "この一覧の最初のエラーを先に直してから、もう一度ビルドしてください。"
      ),
  },
  {
    id: "package-error",
    pattern: /^(?:!\s*)?Package\s+([A-Za-z0-9@._-]+)\s+(Error|Warning):\s*([\s\S]+)$/i,
    kind: (m) =>
      /warning/i.test(m[2])
        ? uiText(`Warning from the ${m[1]} package`, `${m[1]} パッケージからの警告`)
        : uiText(`Error from the ${m[1]} package`, `${m[1]} パッケージからのエラー`),
    summary: (m) => m[3].trim(),
    fix: (m) =>
      uiText(
        `Review how ${m[1]} is used — its options and the arguments you passed it.`,
        `${m[1]} の使い方（オプションと引数）を見直してください。`
      ),
  },
  {
    id: "class-error",
    pattern: /^(?:!\s*)?(?:Document )?Class\s+([A-Za-z0-9@._-]+)\s+(Error|Warning):\s*([\s\S]+)$/i,
    kind: (m) =>
      /warning/i.test(m[2])
        ? uiText(`Warning from the ${m[1]} class`, `${m[1]} クラスからの警告`)
        : uiText(`Error from the ${m[1]} class`, `${m[1]} クラスからのエラー`),
    summary: (m) => m[3].trim(),
    fix: (m) =>
      uiText(
        `Review the options you passed to \\documentclass{${m[1]}}.`,
        `\\documentclass{${m[1]}} に渡しているオプションを見直してください。`
      ),
  },
];

export const diagnoseIssue = (issue: IssueItem): IssueDiagnosis => {
  const raw = issue.message?.trim() ?? "";
  const message = cleanIssueMessage(raw);
  for (const rule of rules) {
    const match = message.match(rule.pattern) ?? raw.match(rule.pattern);
    if (match) {
      return { kind: rule.kind(match), summary: rule.summary(match), fix: rule.fix(match) };
    }
  }
  // Not a log line we recognise: app-level failures already have their own
  // advice, so reuse it rather than inventing a second, worse one.
  return {
    kind:
      issue.severity === "warning"
        ? uiText("Warning", "警告")
        : uiText("Build error", "ビルドエラー"),
    summary: message || uiText("The build reported a problem.", "ビルドが問題を報告しました。"),
    fix:
      getIssueResolution(issue) ??
      uiText(
        "Open the log below to see what the build reported.",
        "下のログを開いて、ビルドが何を報告したか確認してください。"
      ),
  };
};
