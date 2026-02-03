export type WysiwygPackId = "core" | "math" | "physics" | "cs" | "personal" | "jp";

export type WysiwygPackInfo = {
  id: WysiwygPackId;
  label: string;
  description: string;
  defaultEnabled: boolean;
  toggleable: boolean;
};

export const WYSIWYG_PACKS: WysiwygPackInfo[] = [
  {
    id: "core",
    label: "基本",
    description: "主要コマンドと一般的な記号",
    defaultEnabled: true,
    toggleable: false,
  },
  {
    id: "math",
    label: "数学拡張",
    description: "フォント/関係/微積テンプレ",
    defaultEnabled: true,
    toggleable: true,
  },
  {
    id: "physics",
    label: "物理/量子",
    description: "量子・ベクトル解析系",
    defaultEnabled: true,
    toggleable: true,
  },
  {
    id: "cs",
    label: "集合/論理/確率",
    description: "集合演算・論理記号・確率寄り",
    defaultEnabled: true,
    toggleable: true,
  },
  {
    id: "personal",
    label: "個人/装飾",
    description: "boxed/cancel/bm等（好みが分かれる）",
    defaultEnabled: false,
    toggleable: true,
  },
  {
    id: "jp",
    label: "日本語トリガー",
    description: "ローマ字入力（例: sekibun）",
    defaultEnabled: false,
    toggleable: true,
  },
];

export const DEFAULT_WYSIWYG_PACKS: WysiwygPackId[] = WYSIWYG_PACKS.filter(
  (pack) => pack.defaultEnabled
).map((pack) => pack.id);
