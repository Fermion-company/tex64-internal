import { resolveStyle, sceneHasPlot } from "./scene.js";
import { findSymbol } from "./scene.js";
import { samplePathPoints } from "./canvas-math.js";
import { astToPgf, parseExpr, parsePoints } from "./plot-math.js";
import { nodeFontContent, nodeFontOption } from "./label-style.js";
const basicColors = {
    "000000": "black", "ffffff": "white", "ff0000": "red", "00ff00": "green",
    "0000ff": "blue", "00ffff": "cyan", "ff00ff": "magenta", "ffff00": "yellow",
};
const numberText = (value) => {
    const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
};
const point = (value) => `(${numberText(value.x)},${numberText(value.y)})`;
export const generateTikz = (scene) => {
    var _a;
    const customColors = new Map();
    let arrowsUsed = false, patternsUsed = false;
    const colorName = (color) => {
        const hex = color.slice(1).toLowerCase();
        if (basicColors[hex])
            return basicColors[hex];
        const name = `t64${hex.toUpperCase()}`;
        if (!customColors.has(hex))
            customColors.set(hex, name);
        return name;
    };
    const styleKeys = (props, explicitDraw = false) => {
        var _a, _b, _c;
        const keys = [];
        if (props.draw !== undefined && props.draw !== null && (explicitDraw || props.draw.toLowerCase() !== "#000000"))
            keys.push(`draw=${colorName(props.draw)}`);
        if (props.draw === null && explicitDraw)
            keys.push("draw=none");
        if (!props.shading && props.fill !== undefined && props.fill !== null)
            keys.push(props.pattern ? `preaction={fill=${colorName(props.fill)}}` : `fill=${colorName(props.fill)}`);
        if (((_a = props.shading) === null || _a === void 0 ? void 0 : _a.kind) === "axis") {
            keys.push("shade", `top color=${colorName(props.shading.top)}`, `bottom color=${colorName(props.shading.bottom)}`);
            if (props.shading.angle)
                keys.push(`shading angle=${numberText(props.shading.angle)}`);
        }
        else if (((_b = props.shading) === null || _b === void 0 ? void 0 : _b.kind) === "radial")
            keys.push("shade", `inner color=${colorName(props.shading.inner)}`, `outer color=${colorName(props.shading.outer)}`);
        else if (props.pattern) {
            patternsUsed = true;
            keys.push(`pattern=${props.pattern.name}`);
            if (props.pattern.color)
                keys.push(`pattern color=${colorName(props.pattern.color)}`);
        }
        if (props.lineWidthPt !== undefined && props.lineWidthPt !== 0.4)
            keys.push(`line width=${numberText(props.lineWidthPt)}pt`);
        let customDotCap = false;
        if (props.dash && props.dash !== "solid") {
            if (props.dashGapPt !== undefined && props.dashGapPt > 0) {
                const gap = numberText(props.dashGapPt);
                if (props.dash === "dashed") {
                    const on = numberText(Math.max(((_c = props.lineWidthPt) !== null && _c !== void 0 ? _c : 0.4) * 4, 1.2));
                    keys.push(`dash pattern=on ${on}pt off ${gap}pt`);
                }
                else {
                    keys.push(`dash pattern=on 0pt off ${gap}pt`);
                    customDotCap = !props.cap || props.cap === "butt";
                }
            }
            else
                keys.push(props.dash);
        }
        if (props.opacity !== undefined && props.opacity < 1)
            keys.push(`opacity=${numberText(props.opacity)}`);
        const start = props.arrowStart || "";
        const end = props.arrowEnd || "";
        if (start || end) {
            arrowsUsed = true;
            keys.push(`${start ? `{${start}}` : ""}-${end ? `{${end}}` : ""}`);
        }
        if (customDotCap)
            keys.push("line cap=round");
        else if (props.cap && props.cap !== "butt")
            keys.push(`line cap=${props.cap}`);
        if (props.join && props.join !== "miter")
            keys.push(`line join=${props.join}`);
        if (props.roundedCornersPt !== undefined && props.roundedCornersPt > 0)
            keys.push(`rounded corners=${numberText(props.roundedCornersPt)}pt`);
        if (props.doubleDistancePt !== undefined && props.doubleDistancePt > 0)
            keys.push("double", `double distance=${numberText(props.doubleDistancePt)}pt`);
        return keys;
    };
    const objectOptions = (style) => {
        if (style.ref)
            return [style.ref, ...styleKeys(style.props || {}, true)];
        return styleKeys(style.props || {});
    };
    const command = (object) => {
        const effective = resolveStyle(scene, object.style);
        if (effective.shading)
            return effective.draw === null ? "shade" : "draw";
        if ((effective.fill !== null || effective.pattern) && effective.draw === null)
            return "fill";
        if ((effective.fill !== null || effective.pattern) && effective.draw !== null)
            return "filldraw";
        return "draw";
    };
    const withOptions = (name, options) => `\\${name}${options.length ? `[${options.join(", ")}]` : ""}`;
    const transformKeys = (t) => {
        const keys = [];
        if (t.tx !== 0 || t.ty !== 0)
            keys.push(`shift={(${numberText(t.tx)},${numberText(t.ty)})}`);
        if (t.rotate !== 0)
            keys.push(`rotate=${numberText(t.rotate)}`);
        if (t.sx !== 1 || t.sy !== 1) {
            if (t.sx === t.sy)
                keys.push(`scale=${numberText(t.sx)}`);
            else {
                if (t.sx !== 1)
                    keys.push(`xscale=${numberText(t.sx)}`);
                if (t.sy !== 1)
                    keys.push(`yscale=${numberText(t.sy)}`);
            }
        }
        return keys;
    };
    const emitObject = (object, depth) => {
        var _a;
        const indent = "  ".repeat(depth);
        if (object.type === "code") {
            if (/(?:-\{(?:Stealth|Latex|Bar)|\{(?:Stealth|Latex|Bar)\}-)/.test(object.tikz))
                arrowsUsed = true;
            const source = object.tikz.replace(/\r\n?/g, "\n").split("\n");
            while (source.length && !source[0].trim())
                source.shift();
            while (source.length && !source[source.length - 1].trim())
                source.pop();
            const nonBlank = source.filter((line) => line.trim());
            const common = nonBlank.length ? Math.min(...nonBlank.map((line) => line.match(/^\s*/)[0].length)) : 0;
            const lines = source.map((line) => `${indent}${line.slice(common)}`);
            const transform = transformKeys(object.transform);
            if (!transform.length)
                return lines;
            return [`${indent}\\begin{scope}[${transform.join(", ")}]`, ...source.map((line) => `${indent}  ${line.slice(common)}`), `${indent}\\end{scope}`];
        }
        if (object.type === "group") {
            const t = object.transform;
            const transform = transformKeys(t);
            if (!transform.length)
                return object.children.flatMap((child) => emitObject(child, depth));
            return [`${indent}\\begin{scope}[${transform.join(", ")}]`, ...object.children.flatMap((child) => emitObject(child, depth + 1)), `${indent}\\end{scope}`];
        }
        if (object.type === "instance") {
            const symbol = findSymbol(scene, object.symbol);
            if (!symbol)
                return [];
            const options = [...objectOptions(object.style), ...transformKeys(object.transform)];
            return [`${indent}${withOptions("pic", options)} {${symbol.name}};`];
        }
        if (object.type === "repeat") {
            const symbol = findSymbol(scene, object.symbol);
            if (!symbol)
                return [];
            const samples = samplePathPoints(object.path, object.count), style = objectOptions(object.style);
            if (object.align) {
                const list = samples.map((sample) => `${point(sample.point)}/${numberText(sample.angleDeg)}`).join(", ");
                return [`${indent}\\foreach \\p/\\a in {${list}}`, `${indent}  ${withOptions("pic", [...style, "shift={(\\p)}", "rotate=\\a"])} {${symbol.name}};`];
            }
            const list = samples.map((sample) => point(sample.point)).join(", ");
            return [`${indent}\\foreach \\p in {${list}}`, `${indent}  ${withOptions("pic", [...style, "shift={(\\p)}"])} {${symbol.name}};`];
        }
        if (object.type === "plot") {
            const axis = object.axis, opts = [`at={(${numberText(object.at.x)}${scene.unit},${numberText(object.at.y)}${scene.unit})}`, `anchor=south west`, `width=${numberText(object.width)}${scene.unit}`, `height=${numberText(object.height)}${scene.unit}`, "scale only axis", `xmin=${numberText(axis.xmin)}`, `xmax=${numberText(axis.xmax)}`];
            if (axis.ymin !== null)
                opts.push(`ymin=${numberText(axis.ymin)}`);
            if (axis.ymax !== null)
                opts.push(`ymax=${numberText(axis.ymax)}`);
            if (axis.axisLines === "none")
                opts.push("hide axis");
            else if (axis.axisLines !== "box")
                opts.push(`axis lines=${axis.axisLines}`);
            if (axis.grid !== "none")
                opts.push(`grid=${axis.grid}`);
            if (axis.equal)
                opts.push("axis equal");
            const lab = (s) => { const t = s.trim(), esc = s.replace(/([%#&])/g, "\\$1"); return /^\$[^$]*\$$/.test(t) || !/[\^_]/.test(t) ? esc : `$${esc}$`; };
            if (axis.xlabel)
                opts.push(`xlabel={${lab(axis.xlabel)}}`);
            if (axis.ylabel)
                opts.push(`ylabel={${lab(axis.ylabel)}}`);
            if (axis.title)
                opts.push(`title={${lab(axis.title)}}`);
            const lines = [`${indent}\\begin{axis}[${opts.join(", ")}]`];
            for (const series of object.series) {
                if (series.visible === false)
                    continue;
                const kind = series.kind || "fn";
                if (kind === "fn" && !series.expr.trim())
                    continue;
                const a = parseExpr(series.expr), b = kind === "parametric" ? parseExpr(series.expr2 || "") : null, points = kind === "points" ? parsePoints(series.points || "") : [], domain = series.domain || (kind === "fn" ? { min: axis.xmin, max: axis.xmax } : { min: 0, max: 6.28319 });
                if ((kind === "parametric" && (!a || !b)) || (kind === "polar" && !a) || (kind === "points" && !points.length)) {
                    lines.push(`${indent}  % skipped invalid series`);
                    continue;
                }
                const plot = [colorName(series.color)];
                if (series.thick)
                    plot.push("thick");
                if (kind === "points") {
                    plot.unshift("only marks", "mark=*", "mark size=1.6pt");
                    lines.push(`${indent}  \\addplot[${plot.join(", ")}] coordinates {${points.map(point).join(" ")}};`);
                }
                else {
                    plot.unshift(`domain=${numberText(domain.min)}:${numberText(domain.max)}`, `samples=${Math.max(1, Math.floor(series.samples))}`);
                    const body = kind === "fn" ? `{${a ? astToPgf(a, "x") : series.expr}}` : (() => { const first = astToPgf(a, "x"); return kind === "parametric" ? `({${first}},{${astToPgf(b, "x")}})` : `({(${first})*cos(deg(x))},{(${first})*sin(deg(x))})`; })();
                    lines.push(`${indent}  \\addplot[${plot.join(", ")}] ${body};`);
                }
                if (series.legend)
                    lines.push(`${indent}  \\addlegendentry{${lab(series.legend)}}`);
            }
            lines.push(`${indent}\\end{axis}`);
            return lines;
        }
        const options = objectOptions(object.style);
        if (object.type === "node") {
            options.unshift(`anchor=${object.anchor}`);
            const font = nodeFontOption(object.fontFamily, object.fontSize, object.fontShape, object.fontWeight, object.monospace);
            if (font)
                options.push(font);
            const content = nodeFontContent(object.latex, object.fontShape, (_a = object.monospace) !== null && _a !== void 0 ? _a : object.fontFamily === "mono");
            return [`${indent}${withOptions("node", options)} at ${point(object.at)} {${content}};`];
        }
        if (object.type === "path" && !object.segments.length)
            return []; // ペン1クリック中断の残骸（0セグメント）は無意味な \draw を出さない
        const prefix = `${indent}${withOptions(command(object), options)} `;
        if (object.type === "rect")
            return [`${prefix}${point(object.from)} rectangle ${point(object.to)};`];
        if (object.type === "ellipse") {
            const shape = object.rx === object.ry
                ? `circle [radius=${numberText(object.rx)}]`
                : `ellipse [x radius=${numberText(object.rx)}, y radius=${numberText(object.ry)}]`;
            return [`${prefix}${point(object.center)} ${shape};`];
        }
        const parts = [point(object.start), ...object.segments.map((seg) => seg.type === "line"
                ? `-- ${point(seg.to)}` : `.. controls ${point(seg.c1)} and ${point(seg.c2)} .. ${point(seg.to)}`)];
        if (object.closed)
            parts.push("-- cycle");
        const lines = [];
        let current = prefix + parts[0];
        for (const part of parts.slice(1)) {
            if (current.length + part.length + 1 > 100) {
                lines.push(current);
                current = `${indent}  ${part}`;
            }
            else
                current += ` ${part}`;
        }
        lines.push(`${current};`);
        return lines;
    };
    const pictureOptions = [];
    if (scene.unit !== "cm")
        pictureOptions.push(`x=1${scene.unit}`, `y=1${scene.unit}`);
    for (const style of scene.styles)
        pictureOptions.push(`${style.name}/.style={${styleKeys(style.props, true).join(", ")}}`);
    const used = new Set();
    const noteUsed = (objects) => objects.forEach((object) => {
        if (object.type === "instance" || object.type === "repeat")
            used.add(object.symbol);
        else if (object.type === "group")
            noteUsed(object.children);
    });
    noteUsed(scene.objects);
    for (const symbol of scene.symbols || [])
        if (used.has(symbol.id)) {
            const lines = symbol.objects.flatMap((object) => emitObject(object, 2));
            pictureOptions.push(`${symbol.name}/.pic={\n${lines.join("\n")}\n  }`);
        }
    const body = scene.objects.flatMap((object) => emitObject(object, 1));
    const begin = `\\begin{tikzpicture}${pictureOptions.length ? `[${pictureOptions.join(", ")}]` : ""}`;
    const requires = [...(arrowsUsed ? ["arrows.meta"] : []), ...(patternsUsed ? ["patterns"] : [])];
    const definitions = [...customColors].map(([hex, name]) => `\\definecolor{${name}}{HTML}{${hex.toUpperCase()}}`);
    const comment = [...(sceneHasPlot(scene) ? ["% requires: \\usepackage{pgfplots} \\pgfplotsset{compat=1.18}"] : []), ...(requires.length ? [`% requires \\usetikzlibrary{${requires.join(",")}}`] : [])];
    const picture = [begin, ...body, "\\end{tikzpicture}"];
    const relative = ((_a = scene.outputWidth) === null || _a === void 0 ? void 0 : _a.mode) === "relative" ? scene.outputWidth : null;
    const wrapped = relative
        ? [`\\resizebox{${numberText(relative.value)}\\${relative.reference}}{!}{%`, ...picture, "}"]
        : picture;
    return { code: [...definitions, ...comment, ...wrapped].join("\n"), requires, needsGraphicx: Boolean(relative) };
};
