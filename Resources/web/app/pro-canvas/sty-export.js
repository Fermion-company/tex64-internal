import { sceneHasPlot } from "./scene.js";
import { astToPgf, parseExpr, parsePoints } from "./plot-math.js";
const basicColors = { "000000": "black", "ffffff": "white", "ff0000": "red", "00ff00": "green", "0000ff": "blue", "00ffff": "cyan", "ff00ff": "magenta", "ffff00": "yellow" };
const num = (value) => { const n = Math.round((value + Number.EPSILON) * 1000) / 1000; return Object.is(n, -0) ? "0" : String(n); };
const point = (p) => `(${num(p.x)},${num(p.y)})`;
export const buildStyFile = (scene, packageName) => {
    const colors = new Map();
    let arrows = false;
    const color = (value) => { const hex = value.slice(1).toLowerCase(); if (basicColors[hex])
        return basicColors[hex]; const name = `t64${hex.toUpperCase()}`; colors.set(hex, name); return name; };
    const keys = (props, explicit = false) => {
        const out = [];
        if (props.draw !== undefined && props.draw !== null && (explicit || props.draw.toLowerCase() !== "#000000"))
            out.push(`draw=${color(props.draw)}`);
        if (props.draw === null && explicit)
            out.push("draw=none");
        if (props.fill !== undefined && props.fill !== null)
            out.push(`fill=${color(props.fill)}`);
        if (props.lineWidthPt !== undefined && props.lineWidthPt !== .4)
            out.push(`line width=${num(props.lineWidthPt)}pt`);
        if (props.dash && props.dash !== "solid")
            out.push(props.dash);
        if (props.opacity !== undefined && props.opacity < 1)
            out.push(`opacity=${num(props.opacity)}`);
        const start = props.arrowStart || "", end = props.arrowEnd || "";
        if (start || end) {
            arrows = true;
            out.push(`${start ? `{${start}}` : ""}-${end ? `{${end}}` : ""}`);
        }
        if (props.cap && props.cap !== "butt")
            out.push(`line cap=${props.cap}`);
        if (props.join && props.join !== "miter")
            out.push(`line join=${props.join}`);
        if (props.roundedCornersPt !== undefined && props.roundedCornersPt > 0)
            out.push(`rounded corners=${num(props.roundedCornersPt)}pt`);
        if (props.doubleDistancePt !== undefined && props.doubleDistancePt > 0)
            out.push("double", `double distance=${num(props.doubleDistancePt)}pt`);
        return out;
    };
    const options = (style) => style.ref ? [style.ref, ...keys(style.props || {}, true)] : keys(style.props || {});
    const withOptions = (name, opts) => `\\${name}${opts.length ? `[${opts.join(", ")}]` : ""}`;
    const emit = (object, depth) => {
        var _a;
        const indent = "  ".repeat(depth);
        if (object.type === "code") {
            if (/(?:-\{(?:Stealth|Latex|Bar)|\{(?:Stealth|Latex|Bar)\}-)/.test(object.tikz))
                arrows = true;
            const lines = object.tikz.replace(/\r\n?/g, "\n").trim().split("\n").map(line => indent + line);
            const t = object.transform, transform = [];
            if (t.tx || t.ty)
                transform.push(`shift={(${num(t.tx)},${num(t.ty)})}`);
            if (t.rotate)
                transform.push(`rotate=${num(t.rotate)}`);
            if (t.sx !== 1 || t.sy !== 1) {
                if (t.sx === t.sy)
                    transform.push(`scale=${num(t.sx)}`);
                else {
                    if (t.sx !== 1)
                        transform.push(`xscale=${num(t.sx)}`);
                    if (t.sy !== 1)
                        transform.push(`yscale=${num(t.sy)}`);
                }
            }
            return transform.length ? [`${indent}\\begin{scope}[${transform.join(", ")}]`, ...lines.map(line => `  ${line}`), `${indent}\\end{scope}`] : lines;
        }
        if (object.type === "group") {
            const t = object.transform, transform = [];
            if (t.tx || t.ty)
                transform.push(`shift={(${num(t.tx)},${num(t.ty)})}`);
            if (t.rotate)
                transform.push(`rotate=${num(t.rotate)}`);
            if (t.sx !== 1 || t.sy !== 1) {
                if (t.sx === t.sy)
                    transform.push(`scale=${num(t.sx)}`);
                else {
                    if (t.sx !== 1)
                        transform.push(`xscale=${num(t.sx)}`);
                    if (t.sy !== 1)
                        transform.push(`yscale=${num(t.sy)}`);
                }
            }
            if (!transform.length)
                return object.children.flatMap(child => emit(child, depth));
            return [`${indent}\\begin{scope}[${transform.join(", ")}]`, ...object.children.flatMap(child => emit(child, depth + 1)), `${indent}\\end{scope}`];
        }
        if (object.type === "instance" || object.type === "repeat")
            return [];
        if (object.type === "plot") {
            const axis = object.axis, opts = [`at={(${num(object.at.x)}${scene.unit},${num(object.at.y)}${scene.unit})}`, `anchor=south west`, `width=${num(object.width)}${scene.unit}`, `height=${num(object.height)}${scene.unit}`, "scale only axis", `xmin=${num(axis.xmin)}`, `xmax=${num(axis.xmax)}`];
            if (axis.ymin !== null)
                opts.push(`ymin=${num(axis.ymin)}`);
            if (axis.ymax !== null)
                opts.push(`ymax=${num(axis.ymax)}`);
            if (axis.axisLines !== "box")
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
                const kind = series.kind || "fn", a = parseExpr(series.expr), b = kind === "parametric" ? parseExpr(series.expr2 || "") : null, points = kind === "points" ? parsePoints(series.points || "") : [], domain = series.domain || (kind === "fn" ? { min: axis.xmin, max: axis.xmax } : { min: 0, max: 6.28319 });
                if ((kind === "parametric" && (!a || !b)) || (kind === "polar" && !a) || (kind === "points" && !points.length)) {
                    lines.push(`${indent}  % skipped invalid series`);
                    continue;
                }
                const plot = [color(series.color)];
                if (series.thick)
                    plot.push("thick");
                if (kind === "points") {
                    plot.unshift("only marks", "mark=*", "mark size=1.6pt");
                    lines.push(`${indent}  \\addplot[${plot.join(", ")}] coordinates {${points.map(point).join(" ")}};`);
                }
                else {
                    plot.unshift(`domain=${num(domain.min)}:${num(domain.max)}`, `samples=${Math.max(1, Math.floor(series.samples))}`);
                    const body = kind === "fn" ? `{${a ? astToPgf(a, "x") : series.expr}}` : (() => { const first = astToPgf(a, "x"); return kind === "parametric" ? `({${first}},{${astToPgf(b, "x")}})` : `({(${first})*cos(deg(x))},{(${first})*sin(deg(x))})`; })();
                    lines.push(`${indent}  \\addplot[${plot.join(", ")}] ${body};`);
                }
                if (series.legend)
                    lines.push(`${indent}  \\addlegendentry{${lab(series.legend)}}`);
            }
            lines.push(`${indent}\\end{axis}`);
            return lines;
        }
        const opts = options(object.style);
        if (object.type === "node") {
            if (object.anchor !== "center")
                opts.unshift(`anchor=${object.anchor}`);
            return [`${indent}${withOptions("node", opts)} at ${point(object.at)} {${object.latex}};`];
        }
        const effective = { draw: "#000000", fill: null, ...(object.style.ref ? (_a = scene.styles.find(s => s.name === object.style.ref)) === null || _a === void 0 ? void 0 : _a.props : {}), ...(object.style.props || {}) };
        const command = effective.fill !== null ? (effective.draw === null ? "fill" : "filldraw") : "draw";
        const prefix = `${indent}${withOptions(command, opts)} `;
        if (object.type === "rect")
            return [`${prefix}${point(object.from)} rectangle ${point(object.to)};`];
        if (object.type === "ellipse")
            return [`${prefix}${point(object.center)} ${object.rx === object.ry ? `circle [radius=${num(object.rx)}]` : `ellipse [x radius=${num(object.rx)}, y radius=${num(object.ry)}]`};`];
        const parts = [point(object.start), ...object.segments.map(seg => seg.type === "line" ? `-- ${point(seg.to)}` : `.. controls ${point(seg.c1)} and ${point(seg.c2)} .. ${point(seg.to)}`)];
        if (object.closed)
            parts.push("-- cycle");
        return [`${prefix}${parts.join(" ")};`];
    };
    const entries = [];
    for (const style of scene.styles)
        entries.push(`${style.name}/.style={${keys(style.props, true).join(", ")}}`);
    for (const symbol of scene.symbols || [])
        entries.push(`${symbol.name}/.pic={\n${symbol.objects.flatMap(object => emit(object, 2)).join("\n")}\n  }`);
    const definitions = [...colors].map(([hex, name]) => `\\definecolor{${name}}{HTML}{${hex.toUpperCase()}}`);
    return [`\\NeedsTeXFormat{LaTeX2e}`, `\\ProvidesPackage{${packageName}}[2026/08/13 TeX64 figure symbols]`, `\\RequirePackage{tikz}`, ...(sceneHasPlot(scene) ? [`\\RequirePackage{pgfplots}`, `\\pgfplotsset{compat=1.18}`] : []), ...(arrows ? [`\\usetikzlibrary{arrows.meta}`] : []), ...definitions, `\\tikzset{`, entries.map((entry, index) => `  ${entry}${index < entries.length - 1 ? "," : ""}`).join("\n"), `}`, `\\endinput`, ""].join("\n");
};
