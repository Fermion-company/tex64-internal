import type { IssueItem } from "./types.js";

type ResolutionRule = {
  test: (issue: IssueItem, message: string) => boolean;
  resolution: string;
};

const rules: ResolutionRule[] = [
  {
    test: (_issue, message) => message.includes("ワークスペース"),
    resolution: "「フォルダを開く」から作業フォルダを選択してください。",
  },
  {
    test: (_issue, message) => message.includes("ネイティブ連携"),
    resolution: "デスクトップアプリで開いているか確認し、再起動してください。",
  },
  {
    test: (issue, message) =>
      issue.action === "open-runtime" || message.includes("TeX環境"),
    resolution: "設定 > Runtime を開いて、TeX環境のインストール状態を確認してください。",
  },
  {
    test: (_issue, message) => message.includes("latexmk"),
    resolution: "TeX Live などの環境をインストールしてから再実行してください。",
  },
  {
    test: (_issue, message) => message.includes("latexindent"),
    resolution: "latexindent をインストール、または整形設定を見直してください。",
  },
  {
    test: (_issue, message) => message.includes("整形"),
    resolution: "整形設定を見直すか、整形をオフにして再保存してください。",
  },
  {
    test: (_issue, message) => message.includes("ビルドの起動に失敗"),
    resolution: "TeX環境のインストールと PATH を確認し、もう一度ビルドしてください。",
  },
  {
    test: (_issue, message) => message.includes("ビルドに失敗しました"),
    resolution: "ビルドログを確認し、該当ファイルのエラーを修正して再ビルドしてください。",
  },
  {
    test: (_issue, message) =>
      message.includes("SyncTeX") || message.toLowerCase().includes("synctex"),
    resolution: "ビルドしてPDFを生成し、.tex ファイルでSyncTeXを実行してください。",
  },
  {
    test: (_issue, message) => message.includes("PDFが見つかりません"),
    resolution: "ビルドを実行してPDFを生成してください。",
  },
  {
    test: (_issue, message) =>
      message.includes("ファイルを開けません") || message.includes("見つかりません"),
    resolution: "ファイルの存在とパスを確認し、再度開いてください。",
  },
  {
    test: (_issue, message) => message.includes("保存に失敗"),
    resolution: "保存先の権限とディスク容量を確認して再試行してください。",
  },
  {
    test: (_issue, message) => message.includes("このファイル形式は編集できません"),
    resolution: ".tex などのテキストファイルを開いて編集してください。",
  },
  {
    test: (_issue, message) =>
      message.includes("ブロックは .tex") || message.includes("貼り付けは .tex"),
    resolution: ".tex ファイルを開いてから再実行してください。",
  },
  {
    test: (_issue, message) => message.includes("画面キャプチャ"),
    resolution: "画面収録の許可を有効にして再試行してください。",
  },
  {
    test: (_issue, message) =>
      message.includes("画面収録") ||
      message.includes("ウィンドウ一覧") ||
      message.includes("取り込み可能なウィンドウ"),
    resolution: "画面収録の許可を有効にして再試行してください。",
  },
  {
    test: (_issue, message) => message.includes("切り取りに失敗"),
    resolution: "キャプチャ範囲を選択し直して再試行してください。",
  },
  {
    test: (_issue, message) => message.includes("OCR"),
    resolution: "画像を再取得し、文字や数式が鮮明に写っているか確認してください。",
  },
  {
    test: (_issue, message) =>
      message.includes("文字を検出できません") ||
      message.includes("解析失敗") ||
      message.includes("画像がありません"),
    resolution: "画像を撮り直し、コントラストを上げて再度取り込んでください。",
  },
  {
    test: (_issue, message) => message.includes("対応していないファイル形式"),
    resolution: "PNG/JPEG などの画像ファイルを選択して再試行してください。",
  },
  {
    test: (_issue, message) => message.includes("保存容量が一杯"),
    resolution: "取り込みボードの古いアイテムを削除して容量を確保してください。",
  },
  {
    test: (_issue, message) => message.includes("名前を入力"),
    resolution: "空欄にならないよう名前を入力してください。",
  },
  {
    test: (_issue, message) =>
      message.includes("絶対パスは使えません") ||
      message.includes("親ディレクトリを含む名前は使えません") ||
      message.includes("末尾の / は使えません") ||
      message.includes("名前に / は使えません"),
    resolution: "ワークスペース内の相対パスで、/ や .. を含めずに入力してください。",
  },
  {
    test: (_issue, message) => message.includes("移動先が不正"),
    resolution: "移動先フォルダを確認して、別の場所へ移動してください。",
  },
  {
    test: (_issue, message) => message.includes("未保存の変更があります"),
    resolution: "移動/リネーム前に該当ファイルを保存してください。",
  },
];

export const getIssueResolution = (issue: IssueItem) => {
  const message = issue.message?.trim() ?? "";
  if (!message) {
    return null;
  }
  for (const rule of rules) {
    if (rule.test(issue, message)) {
      return rule.resolution;
    }
  }
  return "該当行を確認し、エラー原因を修正してください。";
};
