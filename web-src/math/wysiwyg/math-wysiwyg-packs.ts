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
    label: "Basic",
    description: "Common commands and general symbols",
    defaultEnabled: true,
    toggleable: false,
  },
  {
    id: "math",
    label: "math extension",
    description: "Font/relations/calculus templates",
    defaultEnabled: true,
    toggleable: true,
  },
  {
    id: "physics",
    label: "physics/quantum",
    description: "Quantum/vector analysis",
    defaultEnabled: true,
    toggleable: true,
  },
  {
    id: "cs",
    label: "set/logic/probability",
    description: "Set operations, logic symbols, probability",
    defaultEnabled: true,
    toggleable: true,
  },
  {
    id: "personal",
    label: "personal/decoration",
    description: "boxed/cancel/bm etc. (depends on preference)",
    defaultEnabled: false,
    toggleable: true,
  },
  {
    id: "jp",
    label: "Japanese trigger",
    description: "Romaji input (e.g. sekibun)",
    defaultEnabled: false,
    toggleable: true,
  },
];

export const DEFAULT_WYSIWYG_PACKS: WysiwygPackId[] = WYSIWYG_PACKS.filter(
  (pack) => pack.defaultEnabled
).map((pack) => pack.id);
