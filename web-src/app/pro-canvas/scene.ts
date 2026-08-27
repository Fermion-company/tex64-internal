export type Vec = { x: number; y: number };

export type Transform = { tx: number; ty: number; rotate: number; sx: number; sy: number };

export type PatternName = "horizontal lines" | "vertical lines" | "north east lines" | "north west lines" | "grid" | "crosshatch" | "dots" | "crosshatch dots";

export type StyleProps = {
  draw?: string | null;
  fill?: string | null;
  lineWidthPt?: number;
  dash?: "solid" | "dashed" | "dotted";
  /** 点線・破線の空白部分。0 / undefined は TikZ とプレビューの既定間隔。 */
  dashGapPt?: number;
  opacity?: number;
  arrowStart?: "" | "Stealth" | "Latex" | "Bar";
  arrowEnd?: "" | "Stealth" | "Latex" | "Bar";
  cap?: "butt" | "round" | "rect";
  join?: "miter" | "round" | "bevel";
  roundedCornersPt?: number;
  doubleDistancePt?: number;
  pattern?: { name: PatternName; color?: string } | null;
  shading?: { kind: "axis"; top: string; bottom: string; angle?: number } | { kind: "radial"; inner: string; outer: string } | null;
};

export type SceneOutputWidth =
  | { mode: "natural" }
  | { mode: "relative"; value: number; reference: "linewidth" | "textwidth" | "columnwidth" };

export type ObjStyle = { ref?: string; props?: StyleProps };
export type PlotSeries = { kind?: "fn"|"parametric"|"polar"|"points"; expr: string; expr2?: string; points?: string; domain: { min: number; max: number } | null; samples: number; color: string; thick: boolean; legend: string; visible?: boolean };

export type PathSeg =
  | { type: "line"; to: Vec }
  | { type: "cubic"; c1: Vec; c2: Vec; to: Vec };

export type NodeAnchor = "center" | "north" | "south" | "east" | "west"
  | "north east" | "north west" | "south east" | "south west"
  | "base" | "base east" | "base west"
  | "mid" | "mid east" | "mid west"
  | "text" | "text east" | "text west";

export type NodeFontFamily = "default" | "serif" | "sans" | "mono";
export type NodeFontSize = "tiny" | "scriptsize" | "footnotesize" | "small" | "normal" | "large" | "Large" | "huge";
export type NodeFontShape = "auto" | "italic" | "upright";
export type NodeFontWeight = "normal" | "bold";

export type SceneObject =
  | { id: string; type: "path"; start: Vec; segments: PathSeg[]; closed: boolean; style: ObjStyle }
  | { id: string; type: "rect"; from: Vec; to: Vec; style: ObjStyle }
  | { id: string; type: "ellipse"; center: Vec; rx: number; ry: number; style: ObjStyle }
  | { id: string; type: "node"; at: Vec; latex: string; anchor: NodeAnchor; fontFamily?: NodeFontFamily; fontSize?: NodeFontSize; fontShape?: NodeFontShape; fontWeight?: NodeFontWeight; monospace?: boolean; style: ObjStyle }
  | { id: string; type: "plot"; at: Vec; width: number; height: number;
      axis: { xmin: number; xmax: number; ymin: number | null; ymax: number | null; axisLines: "none" | "box" | "middle" | "left"; grid: "none" | "major" | "both"; equal?: boolean; xlabel: string; ylabel: string; title: string };
      series: PlotSeries[]; style: ObjStyle }
  | { id: string; type: "group"; children: SceneObject[]; transform: Transform }
  | { id: string; type: "code"; tikz: string; transform: Transform }
  | { id: string; type: "instance"; symbol: string; transform: Transform; style: ObjStyle }
  | { id: string; type: "repeat"; symbol: string; path: { start: Vec; segments: PathSeg[] }; count: number; align: boolean; style: ObjStyle };

export type SymbolDef = { id: string; name: string; objects: SceneObject[] };

export type Scene = {
  v: 1;
  unit: "mm" | "cm" | "pt";
  width: number;
  height: number;
  grid: { size: number; snap: boolean };
  /** 紙面上の幅。未指定の旧データは natural と同じ。キャンバス座標の width とは独立。 */
  outputWidth?: SceneOutputWidth;
  styles: Array<{ name: string; props: StyleProps }>;
  objects: SceneObject[];
  symbols?: SymbolDef[];
};

const DEFAULT_STYLE: Required<StyleProps> = {
  draw: "#000000", fill: null, lineWidthPt: 0.4, dash: "solid", opacity: 1,
  dashGapPt: 0,
  arrowStart: "", arrowEnd: "", cap: "butt", join: "miter", roundedCornersPt: 0, doubleDistancePt: 0, pattern: null, shading: null,
};

let idCounter = 0;

export const createEmptyScene = (): Scene => ({
  v: 1, unit: "mm", width: 100, height: 100,
  grid: { size: 5, snap: true }, outputWidth: { mode: "natural" }, styles: [], objects: [],
});

export const newObjectId = (): string =>
  `${(++idCounter).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const cloneScene = (scene: Scene): Scene => JSON.parse(JSON.stringify(scene)) as Scene;

export const resolveStyle = (scene: Scene, style: ObjStyle): StyleProps => {
  const referenced = style.ref ? scene.styles.find((entry) => entry.name === style.ref)?.props : undefined;
  return { ...DEFAULT_STYLE, ...(referenced || {}), ...(style.props || {}) };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isVec = (value: unknown): value is Vec => isRecord(value) && isNumber(value.x) && isNumber(value.y);
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T =>
  typeof value === "string" && choices.includes(value as T);
const isColor = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value));

const isStyleProps = (value: unknown): value is StyleProps => {
  if (!isRecord(value)) return false;
  if (value.draw !== undefined && !isColor(value.draw)) return false;
  if (value.fill !== undefined && !isColor(value.fill)) return false;
  if (value.lineWidthPt !== undefined && (!isNumber(value.lineWidthPt) || value.lineWidthPt < 0)) return false;
  if (value.dash !== undefined && !oneOf(value.dash, ["solid", "dashed", "dotted"] as const)) return false;
  if (value.dashGapPt !== undefined && (!isNumber(value.dashGapPt) || value.dashGapPt < 0)) return false;
  if (value.opacity !== undefined && (!isNumber(value.opacity) || value.opacity < 0 || value.opacity > 1)) return false;
  if (value.arrowStart !== undefined && !oneOf(value.arrowStart, ["", "Stealth", "Latex", "Bar"] as const)) return false;
  if (value.arrowEnd !== undefined && !oneOf(value.arrowEnd, ["", "Stealth", "Latex", "Bar"] as const)) return false;
  if (value.cap !== undefined && !oneOf(value.cap, ["butt", "round", "rect"] as const)) return false;
  if (value.join !== undefined && !oneOf(value.join, ["miter", "round", "bevel"] as const)) return false;
  if (value.roundedCornersPt !== undefined && (!isNumber(value.roundedCornersPt) || value.roundedCornersPt < 0)) return false;
  if (value.pattern !== undefined && value.pattern !== null && (!isRecord(value.pattern) || !oneOf(value.pattern.name, ["horizontal lines", "vertical lines", "north east lines", "north west lines", "grid", "crosshatch", "dots", "crosshatch dots"] as const) || value.pattern.color !== undefined && typeof value.pattern.color !== "string")) return false;
  if (value.shading !== undefined && value.shading !== null) {
    if (!isRecord(value.shading)) return false;
    if (value.shading.kind === "axis") { if (typeof value.shading.top !== "string" || typeof value.shading.bottom !== "string" || value.shading.angle !== undefined && !isNumber(value.shading.angle) || "inner" in value.shading || "outer" in value.shading) return false; }
    else if (value.shading.kind === "radial") { if (typeof value.shading.inner !== "string" || typeof value.shading.outer !== "string" || "top" in value.shading || "bottom" in value.shading || "angle" in value.shading) return false; }
    else return false;
  }
  return value.doubleDistancePt === undefined || (isNumber(value.doubleDistancePt) && value.doubleDistancePt >= 0);
};

const isObjStyle = (value: unknown): value is ObjStyle => isRecord(value)
  && (value.ref === undefined || typeof value.ref === "string")
  && (value.props === undefined || isStyleProps(value.props));

const isSceneOutputWidth = (value: unknown): value is SceneOutputWidth => {
  if (!isRecord(value)) return false;
  if (value.mode === "natural") return Object.keys(value).every((key) => key === "mode");
  return value.mode === "relative"
    && isNumber(value.value) && value.value > 0 && value.value <= 10
    && oneOf(value.reference, ["linewidth", "textwidth", "columnwidth"] as const);
};

const anchors: readonly NodeAnchor[] = [
  "center", "north", "south", "east", "west", "north east", "north west", "south east", "south west",
  "base", "base east", "base west", "mid", "mid east", "mid west", "text", "text east", "text west",
];

const isTransform = (value: unknown): value is Transform => isRecord(value)
  && isNumber(value.tx) && isNumber(value.ty) && isNumber(value.rotate) && isNumber(value.sx) && isNumber(value.sy);
const isPathSegments = (value: unknown): value is PathSeg[] => Array.isArray(value)
  && value.every((seg) => isRecord(seg) && (seg.type === "line" ? isVec(seg.to)
    : seg.type === "cubic" && isVec(seg.c1) && isVec(seg.c2) && isVec(seg.to)));

const isSceneObject = (value: unknown): value is SceneObject => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") return false;
  if (value.type === "group") {
    return Array.isArray(value.children) && value.children.every(isSceneObject) && isTransform(value.transform);
  }
  if (value.type === "code") return typeof value.tikz === "string" && isTransform(value.transform);
  if (!isObjStyle(value.style)) return false;
  if (value.type === "instance") return typeof value.symbol === "string" && isTransform(value.transform);
  if (value.type === "repeat") return typeof value.symbol === "string" && isRecord(value.path)
    && isVec(value.path.start) && isPathSegments(value.path.segments)
    && Number.isInteger(value.count) && (value.count as number) > 0 && typeof value.align === "boolean";
  if (value.type === "plot") return isVec(value.at) && isNumber(value.width) && value.width > 0 && isNumber(value.height) && value.height > 0
    && isRecord(value.axis) && isNumber(value.axis.xmin) && isNumber(value.axis.xmax)
    && (value.axis.ymin === null || isNumber(value.axis.ymin)) && (value.axis.ymax === null || isNumber(value.axis.ymax))
    && oneOf(value.axis.axisLines,["none","box","middle","left"] as const) && oneOf(value.axis.grid,["none","major","both"] as const) && (value.axis.equal===undefined||typeof value.axis.equal==="boolean")
    && typeof value.axis.xlabel === "string" && typeof value.axis.ylabel === "string" && typeof value.axis.title === "string"
    && Array.isArray(value.series) && value.series.every(series=>isRecord(series) && typeof series.expr === "string" && (series.kind===undefined||oneOf(series.kind,["fn","parametric","polar","points"] as const))
      && (series.kind!=="parametric"||typeof series.expr2==="string") && (series.kind!=="points"||typeof series.points==="string")
      && (series.domain === null || (isRecord(series.domain) && isNumber(series.domain.min) && isNumber(series.domain.max)))
      && Number.isInteger(series.samples) && (series.samples as number) > 0 && typeof series.color === "string" && /^#[0-9a-fA-F]{6}$/.test(series.color)
      && typeof series.thick === "boolean" && typeof series.legend === "string" && (series.visible===undefined||typeof series.visible==="boolean"));
  if (value.type === "rect") return isVec(value.from) && isVec(value.to);
  if (value.type === "ellipse") return isVec(value.center) && isNumber(value.rx) && value.rx >= 0 && isNumber(value.ry) && value.ry >= 0;
  if (value.type === "node") return isVec(value.at) && typeof value.latex === "string" && oneOf(value.anchor, anchors)
    && (value.fontFamily === undefined || oneOf(value.fontFamily, ["default", "serif", "sans", "mono"] as const))
    && (value.fontSize === undefined || oneOf(value.fontSize, ["tiny", "scriptsize", "footnotesize", "small", "normal", "large", "Large", "huge"] as const))
    && (value.fontShape === undefined || oneOf(value.fontShape, ["auto", "italic", "upright"] as const))
    && (value.fontWeight === undefined || oneOf(value.fontWeight, ["normal", "bold"] as const))
    && (value.monospace === undefined || typeof value.monospace === "boolean");
  if (value.type === "path") return isVec(value.start) && typeof value.closed === "boolean" && isPathSegments(value.segments);
  return false;
};

const symbolObjectAllowed = (object: SceneObject): boolean => object.type !== "instance" && object.type !== "repeat"
  && (object.type !== "group" || object.children.every(symbolObjectAllowed));

export const validateScene = (value: unknown): Scene | null => {
  if (!isRecord(value) || value.v !== 1 || !oneOf(value.unit, ["mm", "cm", "pt"] as const)
    || !isNumber(value.width) || value.width < 0 || !isNumber(value.height) || value.height < 0
    || !isRecord(value.grid) || !isNumber(value.grid.size) || value.grid.size <= 0 || typeof value.grid.snap !== "boolean"
    || (value.outputWidth !== undefined && !isSceneOutputWidth(value.outputWidth))
    || !Array.isArray(value.styles) || !value.styles.every((style) => isRecord(style)
      && typeof style.name === "string" && /^[A-Za-z]+$/.test(style.name) && isStyleProps(style.props))
    || !Array.isArray(value.objects) || !value.objects.every(isSceneObject)
    || (value.symbols !== undefined && (!Array.isArray(value.symbols) || !value.symbols.every((symbol) => isRecord(symbol)
      && typeof symbol.id === "string" && typeof symbol.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(symbol.name)
      && Array.isArray(symbol.objects) && symbol.objects.every((object) => isSceneObject(object) && symbolObjectAllowed(object)))))) return null;
  return value as unknown as Scene;
};

export const findSymbol = (scene: Scene, id: string): SymbolDef | undefined =>
  (scene.symbols || []).find((symbol) => symbol.id === id);

export const sceneHasPlot = (scene: Scene): boolean => {
  const has=(objects:SceneObject[]):boolean=>objects.some(object=>object.type==="plot"||(object.type==="group"&&has(object.children)));
  return has(scene.objects)||(scene.symbols||[]).some(symbol=>has(symbol.objects));
};
