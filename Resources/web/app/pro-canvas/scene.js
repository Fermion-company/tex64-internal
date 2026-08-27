const DEFAULT_STYLE = {
    draw: "#000000", fill: null, lineWidthPt: 0.4, dash: "solid", opacity: 1,
    dashGapPt: 0,
    arrowStart: "", arrowEnd: "", cap: "butt", join: "miter", roundedCornersPt: 0, doubleDistancePt: 0, pattern: null, shading: null,
};
let idCounter = 0;
export const createEmptyScene = () => ({
    v: 1, unit: "mm", width: 100, height: 100,
    grid: { size: 5, snap: true }, outputWidth: { mode: "natural" }, styles: [], objects: [],
});
export const newObjectId = () => `${(++idCounter).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const cloneScene = (scene) => JSON.parse(JSON.stringify(scene));
export const resolveStyle = (scene, style) => {
    var _a;
    const referenced = style.ref ? (_a = scene.styles.find((entry) => entry.name === style.ref)) === null || _a === void 0 ? void 0 : _a.props : undefined;
    return { ...DEFAULT_STYLE, ...(referenced || {}), ...(style.props || {}) };
};
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isVec = (value) => isRecord(value) && isNumber(value.x) && isNumber(value.y);
const oneOf = (value, choices) => typeof value === "string" && choices.includes(value);
const isColor = (value) => value === null || (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value));
const isStyleProps = (value) => {
    if (!isRecord(value))
        return false;
    if (value.draw !== undefined && !isColor(value.draw))
        return false;
    if (value.fill !== undefined && !isColor(value.fill))
        return false;
    if (value.lineWidthPt !== undefined && (!isNumber(value.lineWidthPt) || value.lineWidthPt < 0))
        return false;
    if (value.dash !== undefined && !oneOf(value.dash, ["solid", "dashed", "dotted"]))
        return false;
    if (value.dashGapPt !== undefined && (!isNumber(value.dashGapPt) || value.dashGapPt < 0))
        return false;
    if (value.opacity !== undefined && (!isNumber(value.opacity) || value.opacity < 0 || value.opacity > 1))
        return false;
    if (value.arrowStart !== undefined && !oneOf(value.arrowStart, ["", "Stealth", "Latex", "Bar"]))
        return false;
    if (value.arrowEnd !== undefined && !oneOf(value.arrowEnd, ["", "Stealth", "Latex", "Bar"]))
        return false;
    if (value.cap !== undefined && !oneOf(value.cap, ["butt", "round", "rect"]))
        return false;
    if (value.join !== undefined && !oneOf(value.join, ["miter", "round", "bevel"]))
        return false;
    if (value.roundedCornersPt !== undefined && (!isNumber(value.roundedCornersPt) || value.roundedCornersPt < 0))
        return false;
    if (value.pattern !== undefined && value.pattern !== null && (!isRecord(value.pattern) || !oneOf(value.pattern.name, ["horizontal lines", "vertical lines", "north east lines", "north west lines", "grid", "crosshatch", "dots", "crosshatch dots"]) || value.pattern.color !== undefined && typeof value.pattern.color !== "string"))
        return false;
    if (value.shading !== undefined && value.shading !== null) {
        if (!isRecord(value.shading))
            return false;
        if (value.shading.kind === "axis") {
            if (typeof value.shading.top !== "string" || typeof value.shading.bottom !== "string" || value.shading.angle !== undefined && !isNumber(value.shading.angle) || "inner" in value.shading || "outer" in value.shading)
                return false;
        }
        else if (value.shading.kind === "radial") {
            if (typeof value.shading.inner !== "string" || typeof value.shading.outer !== "string" || "top" in value.shading || "bottom" in value.shading || "angle" in value.shading)
                return false;
        }
        else
            return false;
    }
    return value.doubleDistancePt === undefined || (isNumber(value.doubleDistancePt) && value.doubleDistancePt >= 0);
};
const isObjStyle = (value) => isRecord(value)
    && (value.ref === undefined || typeof value.ref === "string")
    && (value.props === undefined || isStyleProps(value.props));
const isSceneOutputWidth = (value) => {
    if (!isRecord(value))
        return false;
    if (value.mode === "natural")
        return Object.keys(value).every((key) => key === "mode");
    return value.mode === "relative"
        && isNumber(value.value) && value.value > 0 && value.value <= 10
        && oneOf(value.reference, ["linewidth", "textwidth", "columnwidth"]);
};
const anchors = [
    "center", "north", "south", "east", "west", "north east", "north west", "south east", "south west",
    "base", "base east", "base west", "mid", "mid east", "mid west", "text", "text east", "text west",
];
const isTransform = (value) => isRecord(value)
    && isNumber(value.tx) && isNumber(value.ty) && isNumber(value.rotate) && isNumber(value.sx) && isNumber(value.sy);
const isPathSegments = (value) => Array.isArray(value)
    && value.every((seg) => isRecord(seg) && (seg.type === "line" ? isVec(seg.to)
        : seg.type === "cubic" && isVec(seg.c1) && isVec(seg.c2) && isVec(seg.to)));
const isSceneObject = (value) => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string")
        return false;
    if (value.type === "group") {
        return Array.isArray(value.children) && value.children.every(isSceneObject) && isTransform(value.transform);
    }
    if (value.type === "code")
        return typeof value.tikz === "string" && isTransform(value.transform);
    if (!isObjStyle(value.style))
        return false;
    if (value.type === "instance")
        return typeof value.symbol === "string" && isTransform(value.transform);
    if (value.type === "repeat")
        return typeof value.symbol === "string" && isRecord(value.path)
            && isVec(value.path.start) && isPathSegments(value.path.segments)
            && Number.isInteger(value.count) && value.count > 0 && typeof value.align === "boolean";
    if (value.type === "plot")
        return isVec(value.at) && isNumber(value.width) && value.width > 0 && isNumber(value.height) && value.height > 0
            && isRecord(value.axis) && isNumber(value.axis.xmin) && isNumber(value.axis.xmax)
            && (value.axis.ymin === null || isNumber(value.axis.ymin)) && (value.axis.ymax === null || isNumber(value.axis.ymax))
            && oneOf(value.axis.axisLines, ["none", "box", "middle", "left"]) && oneOf(value.axis.grid, ["none", "major", "both"]) && (value.axis.equal === undefined || typeof value.axis.equal === "boolean")
            && typeof value.axis.xlabel === "string" && typeof value.axis.ylabel === "string" && typeof value.axis.title === "string"
            && Array.isArray(value.series) && value.series.every(series => isRecord(series) && typeof series.expr === "string" && (series.kind === undefined || oneOf(series.kind, ["fn", "parametric", "polar", "points"]))
            && (series.kind !== "parametric" || typeof series.expr2 === "string") && (series.kind !== "points" || typeof series.points === "string")
            && (series.domain === null || (isRecord(series.domain) && isNumber(series.domain.min) && isNumber(series.domain.max)))
            && Number.isInteger(series.samples) && series.samples > 0 && typeof series.color === "string" && /^#[0-9a-fA-F]{6}$/.test(series.color)
            && typeof series.thick === "boolean" && typeof series.legend === "string" && (series.visible === undefined || typeof series.visible === "boolean"));
    if (value.type === "rect")
        return isVec(value.from) && isVec(value.to);
    if (value.type === "ellipse")
        return isVec(value.center) && isNumber(value.rx) && value.rx >= 0 && isNumber(value.ry) && value.ry >= 0;
    if (value.type === "node")
        return isVec(value.at) && typeof value.latex === "string" && oneOf(value.anchor, anchors)
            && (value.fontFamily === undefined || oneOf(value.fontFamily, ["default", "serif", "sans", "mono"]))
            && (value.fontSize === undefined || oneOf(value.fontSize, ["tiny", "scriptsize", "footnotesize", "small", "normal", "large", "Large", "huge"]))
            && (value.fontShape === undefined || oneOf(value.fontShape, ["auto", "italic", "upright"]))
            && (value.fontWeight === undefined || oneOf(value.fontWeight, ["normal", "bold"]))
            && (value.monospace === undefined || typeof value.monospace === "boolean");
    if (value.type === "path")
        return isVec(value.start) && typeof value.closed === "boolean" && isPathSegments(value.segments);
    return false;
};
const symbolObjectAllowed = (object) => object.type !== "instance" && object.type !== "repeat"
    && (object.type !== "group" || object.children.every(symbolObjectAllowed));
export const validateScene = (value) => {
    if (!isRecord(value) || value.v !== 1 || !oneOf(value.unit, ["mm", "cm", "pt"])
        || !isNumber(value.width) || value.width < 0 || !isNumber(value.height) || value.height < 0
        || !isRecord(value.grid) || !isNumber(value.grid.size) || value.grid.size <= 0 || typeof value.grid.snap !== "boolean"
        || (value.outputWidth !== undefined && !isSceneOutputWidth(value.outputWidth))
        || !Array.isArray(value.styles) || !value.styles.every((style) => isRecord(style)
        && typeof style.name === "string" && /^[A-Za-z]+$/.test(style.name) && isStyleProps(style.props))
        || !Array.isArray(value.objects) || !value.objects.every(isSceneObject)
        || (value.symbols !== undefined && (!Array.isArray(value.symbols) || !value.symbols.every((symbol) => isRecord(symbol)
            && typeof symbol.id === "string" && typeof symbol.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(symbol.name)
            && Array.isArray(symbol.objects) && symbol.objects.every((object) => isSceneObject(object) && symbolObjectAllowed(object))))))
        return null;
    return value;
};
export const findSymbol = (scene, id) => (scene.symbols || []).find((symbol) => symbol.id === id);
export const sceneHasPlot = (scene) => {
    const has = (objects) => objects.some(object => object.type === "plot" || (object.type === "group" && has(object.children)));
    return has(scene.objects) || (scene.symbols || []).some(symbol => has(symbol.objects));
};
