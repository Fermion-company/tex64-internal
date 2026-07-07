/**
 * Color swatch hover for xcolor-style commands (\textcolor, \color,
 * \definecolor, \colorbox, ...). Pure parsing/resolution functions are
 * exported for unit tests; only buildColorSwatchHtml touches presentation.
 */

export type Rgb = { r: number; g: number; b: number };

// xcolor base colors (always available with \usepackage{xcolor}).
const BASE_COLORS: Record<string, string> = {
  black: "#000000",
  blue: "#0000FF",
  brown: "#BF8040",
  cyan: "#00FFFF",
  darkgray: "#404040",
  gray: "#808080",
  green: "#00FF00",
  lightgray: "#BFBFBF",
  lime: "#BFFF00",
  magenta: "#FF00FF",
  olive: "#808000",
  orange: "#FF8000",
  pink: "#FFBFBF",
  purple: "#BF0040",
  red: "#FF0000",
  teal: "#008080",
  violet: "#800080",
  white: "#FFFFFF",
  yellow: "#FFFF00",
};

// dvipsnames option (RGB renderings of the standard 68 dvips colors).
const DVIPS_COLORS: Record<string, string> = {
  Apricot: "#FBB982",
  Aquamarine: "#00B5BE",
  Bittersweet: "#C04F17",
  Black: "#221E1F",
  Blue: "#2D2F92",
  BlueGreen: "#00B3B8",
  BlueViolet: "#473992",
  BrickRed: "#B6321C",
  Brown: "#792500",
  BurntOrange: "#F7921D",
  CadetBlue: "#74729A",
  CarnationPink: "#F282B4",
  Cerulean: "#00A2E3",
  CornflowerBlue: "#41B0E4",
  Cyan: "#00AEEF",
  Dandelion: "#FDBC42",
  DarkOrchid: "#A4538A",
  Emerald: "#00A99D",
  ForestGreen: "#009B55",
  Fuchsia: "#8C368C",
  Goldenrod: "#FFDF42",
  Gray: "#949698",
  Green: "#00A64F",
  GreenYellow: "#DFE674",
  JungleGreen: "#00A99A",
  Lavender: "#F49EC4",
  LimeGreen: "#8DC73E",
  Magenta: "#EC008C",
  Mahogany: "#A9341F",
  Maroon: "#AF3235",
  Melon: "#F89E7B",
  MidnightBlue: "#006795",
  Mulberry: "#A93C93",
  NavyBlue: "#006EB8",
  OliveGreen: "#3C8031",
  Orange: "#F58137",
  OrangeRed: "#ED135A",
  Orchid: "#AF72B0",
  Peach: "#F7965A",
  Periwinkle: "#7977B8",
  PineGreen: "#008B72",
  Plum: "#92268F",
  ProcessBlue: "#00B0F0",
  Purple: "#99479B",
  RawSienna: "#974006",
  Red: "#ED1B23",
  RedOrange: "#F26035",
  RedViolet: "#A1246B",
  Rhodamine: "#EF559F",
  RoyalBlue: "#0071BC",
  RoyalPurple: "#613F99",
  RubineRed: "#ED017D",
  Salmon: "#F69289",
  SeaGreen: "#3FBC9D",
  Sepia: "#671800",
  SkyBlue: "#46C5DD",
  SpringGreen: "#C6DC67",
  Tan: "#DA9D76",
  TealBlue: "#00AEB3",
  Thistle: "#D883B7",
  Turquoise: "#00B4CE",
  Violet: "#58429B",
  VioletRed: "#EF58A0",
  White: "#FFFFFF",
  WildStrawberry: "#EE2967",
  Yellow: "#FFF200",
  YellowGreen: "#98CC70",
  YellowOrange: "#FAA21A",
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const clamp255 = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

export const hexToRgb = (hex: string): Rgb | null => {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
};

export const rgbToHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0").toUpperCase()).join("")}`;

const lookupNamedColor = (name: string, defined?: Map<string, Rgb>): Rgb | null => {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  const fromDefined = defined?.get(trimmed);
  if (fromDefined) {
    return { ...fromDefined };
  }
  const base = BASE_COLORS[trimmed.toLowerCase()];
  if (base) {
    return hexToRgb(base);
  }
  const dvips = DVIPS_COLORS[trimmed];
  if (dvips) {
    return hexToRgb(dvips);
  }
  return null;
};

const mixColors = (a: Rgb, pct: number, b: Rgb): Rgb => {
  const p = clamp01(pct / 100);
  return {
    r: a.r * p + b.r * (1 - p),
    g: a.g * p + b.g * (1 - p),
    b: a.b * p + b.b * (1 - p),
  };
};

/**
 * Resolve an xcolor name expression, including `!` mixes:
 *   "red" | "red!50" (50% red on white) | "blue!30!black" | chained mixes.
 */
export const resolveColorExpression = (
  expression: string,
  defined?: Map<string, Rgb>
): Rgb | null => {
  const tokens = expression.split("!").map((token) => token.trim());
  if (tokens.length === 0 || !tokens[0]) {
    return null;
  }
  let current = lookupNamedColor(tokens[0], defined);
  if (!current) {
    return null;
  }
  let i = 1;
  const white: Rgb = { r: 255, g: 255, b: 255 };
  while (i < tokens.length) {
    const pct = Number(tokens[i]);
    if (!Number.isFinite(pct)) {
      return null;
    }
    const partnerToken = tokens[i + 1];
    const partner = partnerToken ? lookupNamedColor(partnerToken, defined) : white;
    if (!partner) {
      return null;
    }
    current = mixColors(current, pct, partner);
    i += 2;
  }
  return { r: clamp255(current.r), g: clamp255(current.g), b: clamp255(current.b) };
};

/** Resolve a color spec under an explicit \definecolor-style model. */
export const resolveModelColor = (model: string, spec: string): Rgb | null => {
  const parts = spec.split(",").map((part) => Number(part.trim()));
  switch (model.trim().toLowerCase()) {
    case "rgb": {
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
      return { r: clamp255(parts[0] * 255), g: clamp255(parts[1] * 255), b: clamp255(parts[2] * 255) };
    }
    case "gray": {
      if (parts.length !== 1 || !Number.isFinite(parts[0])) return null;
      const v = clamp255(parts[0] * 255);
      return { r: v, g: v, b: v };
    }
    case "cmyk": {
      if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
      const [c, m, y, k] = parts.map(clamp01);
      return {
        r: clamp255(255 * (1 - c) * (1 - k)),
        g: clamp255(255 * (1 - m) * (1 - k)),
        b: clamp255(255 * (1 - y) * (1 - k)),
      };
    }
    case "html":
      return hexToRgb(spec);
    default:
      return null;
  }
};

/** Case-sensitive model dispatch (RGB vs rgb differ in xcolor). */
export const resolveColorSpec = (
  spec: string,
  model?: string | null,
  defined?: Map<string, Rgb>
): Rgb | null => {
  const trimmedSpec = spec.trim();
  if (!trimmedSpec) {
    return null;
  }
  if (model && model.trim()) {
    const trimmedModel = model.trim();
    if (trimmedModel === "RGB") {
      const parts = trimmedSpec.split(",").map((part) => Number(part.trim()));
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
      return { r: clamp255(parts[0]), g: clamp255(parts[1]), b: clamp255(parts[2]) };
    }
    if (trimmedModel.toLowerCase() === "named") {
      return resolveColorExpression(trimmedSpec, defined);
    }
    return resolveModelColor(trimmedModel, trimmedSpec);
  }
  return resolveColorExpression(trimmedSpec, defined);
};

const DEFINECOLOR_REGEX =
  /\\(?:definecolor|providecolor|colorlet)\s*\{([^{}]+)\}\s*(?:\{([^{}]+)\}\s*)?\{([^{}]+)\}/g;

/**
 * Scan a document (via line accessor) for \definecolor / \providecolor /
 * \colorlet definitions so user-defined names resolve in hovers.
 */
export const collectDefinedColors = (
  getLineContent: (lineNumber: number) => string,
  lineCount: number,
  maxLines = 2000
): Map<string, Rgb> => {
  const defined = new Map<string, Rgb>();
  const limit = Math.min(lineCount, maxLines);
  for (let lineNumber = 1; lineNumber <= limit; lineNumber += 1) {
    let line = "";
    try {
      line = getLineContent(lineNumber) ?? "";
    } catch {
      break;
    }
    if (!line.includes("color")) {
      continue;
    }
    DEFINECOLOR_REGEX.lastIndex = 0;
    let match = DEFINECOLOR_REGEX.exec(line);
    while (match) {
      const name = (match[1] ?? "").trim();
      const model = match[2];
      const spec = (match[3] ?? "").trim();
      if (name && spec) {
        // \colorlet{name}{expr} has no model group; the regex puts the
        // expression in the last group either way.
        const rgb = resolveColorSpec(spec, model ?? null, defined);
        if (rgb) {
          defined.set(name, rgb);
        }
      }
      match = DEFINECOLOR_REGEX.exec(line);
    }
  }
  return defined;
};

/** Relative luminance — used to pick a readable border for the swatch. */
const isLight = ({ r, g, b }: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;

export const buildColorSwatchHtml = (rgb: Rgb, label: string): string => {
  const hex = rgbToHex(rgb);
  const safeLabel = label
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const border = isLight(rgb) ? "rgba(15,23,42,0.55)" : "rgba(247,250,255,0.55)";
  const width = 190;
  const height = 34;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="6" fill="rgba(39,54,84,0.98)"/>`,
    `<rect x="8" y="7" width="20" height="20" rx="4" fill="${hex}" stroke="${border}" stroke-width="1"/>`,
    `<text x="38" y="22" font-family="ui-monospace,Menlo,monospace" font-size="13" fill="rgba(247,250,255,0.99)">${hex} ${safeLabel}</text>`,
    `</svg>`,
  ].join("");
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}#tex64-color`;
  const escaped = dataUrl.replace(/"/g, "&quot;");
  return `<div class="tex64-hover-preview tex64-hover-preview-color" data-tex64-preview="color"><img src="${escaped}" alt="${safeLabel}" /></div>`;
};
