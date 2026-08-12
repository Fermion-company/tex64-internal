import { newObjectId } from "./scene.js";
const tokens = (d) => d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
const isCommand = (s) => Boolean(s && /^[A-Za-z]$/.test(s));
/** Parse the SVG path subset used by the canvas. Unsupported arcs are consumed and skipped. */
export const parseSvgPathData = (d) => {
    const input = tokens(d);
    let i = 0, command = "", current = { x: 0, y: 0 }, start = null;
    let lastCubic = null, lastQuad = null;
    const segments = [];
    let closed = false;
    const warnings = [];
    const number = () => { const value = Number(input[i++]); return Number.isFinite(value) ? value : null; };
    const pair = (relative) => { const x = number(), y = number(); return x === null || y === null ? null : { x: x + (relative ? current.x : 0), y: y + (relative ? current.y : 0) }; };
    while (i < input.length) {
        if (isCommand(input[i]))
            command = input[i++];
        else if (!command)
            return null;
        const lower = command.toLowerCase(), relative = command === lower;
        if (lower === "z") {
            if (start)
                current = { ...start };
            closed = true;
            lastCubic = lastQuad = null;
            command = "";
            continue;
        }
        if (lower === "m") {
            const p = pair(relative);
            if (!p)
                return null;
            current = p;
            if (!start)
                start = { ...p };
            else {
                segments.push({ type: "line", to: { ...p } });
                if (!warnings.includes("SVG subpaths were connected into one path"))
                    warnings.push("SVG subpaths were connected into one path");
            }
            command = relative ? "l" : "L";
            lastCubic = lastQuad = null;
            continue;
        }
        if (!start)
            return null;
        if (lower === "l") {
            const p = pair(relative);
            if (!p)
                return null;
            segments.push({ type: "line", to: p });
            current = p;
            lastCubic = lastQuad = null;
            continue;
        }
        if (lower === "h") {
            const x = number();
            if (x === null)
                return null;
            current = { x: x + (relative ? current.x : 0), y: current.y };
            segments.push({ type: "line", to: { ...current } });
            lastCubic = lastQuad = null;
            continue;
        }
        if (lower === "v") {
            const y = number();
            if (y === null)
                return null;
            current = { x: current.x, y: y + (relative ? current.y : 0) };
            segments.push({ type: "line", to: { ...current } });
            lastCubic = lastQuad = null;
            continue;
        }
        if (lower === "c") {
            const c1 = pair(relative), c2 = pair(relative), to = pair(relative);
            if (!c1 || !c2 || !to)
                return null;
            segments.push({ type: "cubic", c1, c2, to });
            current = to;
            lastCubic = c2;
            lastQuad = null;
            continue;
        }
        if (lower === "s") {
            const c1 = lastCubic ? { x: 2 * current.x - lastCubic.x, y: 2 * current.y - lastCubic.y } : { ...current };
            const c2 = pair(relative), to = pair(relative);
            if (!c2 || !to)
                return null;
            segments.push({ type: "cubic", c1, c2, to });
            current = to;
            lastCubic = c2;
            lastQuad = null;
            continue;
        }
        if (lower === "q") {
            const q = pair(relative), to = pair(relative);
            if (!q || !to)
                return null;
            const from = { ...current };
            segments.push({ type: "cubic", c1: { x: from.x + 2 * (q.x - from.x) / 3, y: from.y + 2 * (q.y - from.y) / 3 }, c2: { x: to.x + 2 * (q.x - to.x) / 3, y: to.y + 2 * (q.y - to.y) / 3 }, to });
            current = to;
            lastQuad = q;
            lastCubic = null;
            continue;
        }
        if (lower === "t") {
            const q = lastQuad ? { x: 2 * current.x - lastQuad.x, y: 2 * current.y - lastQuad.y } : { ...current };
            const to = pair(relative);
            if (!to)
                return null;
            const from = { ...current };
            segments.push({ type: "cubic", c1: { x: from.x + 2 * (q.x - from.x) / 3, y: from.y + 2 * (q.y - from.y) / 3 }, c2: { x: to.x + 2 * (q.x - to.x) / 3, y: to.y + 2 * (q.y - to.y) / 3 }, to });
            current = to;
            lastQuad = q;
            lastCubic = null;
            continue;
        }
        if (lower === "a") {
            const values = [];
            for (let n = 0; n < 7; n += 1) {
                const v = number();
                if (v === null)
                    return null;
                values.push(v);
            }
            current = { x: values[5] + (relative ? current.x : 0), y: values[6] + (relative ? current.y : 0) };
            warnings.push("SVG path arc (A) was skipped");
            lastCubic = lastQuad = null;
            continue;
        }
        return null;
    }
    return start ? { start, segments, closed, ...(warnings.length ? { warnings } : {}) } : null;
};
const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const multiply = (p, q) => ({ a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b, c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d, e: p.a * q.e + p.c * q.f + p.e, f: p.b * q.e + p.d * q.f + p.f });
const apply = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
const transformMatrix = (text) => { var _a, _b, _c; let out = identity, match; const pattern = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/gi; while ((match = pattern.exec(text || ""))) {
    const n = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let m = identity;
    if (match[1].toLowerCase() === "matrix" && n.length >= 6)
        m = { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
    else if (match[1].toLowerCase() === "translate")
        m = { ...identity, e: n[0] || 0, f: n[1] || 0 };
    else if (match[1].toLowerCase() === "scale")
        m = { ...identity, a: (_a = n[0]) !== null && _a !== void 0 ? _a : 1, d: (_c = (_b = n[1]) !== null && _b !== void 0 ? _b : n[0]) !== null && _c !== void 0 ? _c : 1 };
    else if (match[1].toLowerCase() === "rotate") {
        const r = (n[0] || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), rot = { ...identity, a: c, b: s, c: -s, d: c };
        m = n.length >= 3 ? multiply(multiply({ ...identity, e: n[1], f: n[2] }, rot), { ...identity, e: -n[1], f: -n[2] }) : rot;
    }
    out = multiply(out, m);
} return out; };
const num = (el, name, fallback = 0) => Number(el.getAttribute(name)) || fallback;
const color = (value, warnings) => { if (value === null)
    return undefined; if (value.toLowerCase() === "none")
    return null; if (/^#[0-9a-f]{6}$/i.test(value))
    return value.toLowerCase(); if (/^#[0-9a-f]{3}$/i.test(value))
    return `#${[...value.slice(1)].map(x => x + x).join("")}`.toLowerCase(); warnings.push(`Named SVG color "${value}" was replaced with black`); return "#000000"; };
export const importSvg = (svgText, targetWidth) => {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;
    if (root.localName !== "svg" || doc.querySelector("parsererror"))
        return null;
    const warnings = [], objects = [];
    // Illustrator/Inkscape は presentation attribute でなく style="" に出すことが多い。
    const styleDecls = (el) => { const out = {}; for (const part of (el.getAttribute("style") || "").split(";")) {
        const i = part.indexOf(":");
        if (i > 0)
            out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    } return out; };
    const style = (el) => { var _a, _b, _c; const decl = styleDecls(el); const width = Number((_a = decl["stroke-width"]) !== null && _a !== void 0 ? _a : el.getAttribute("stroke-width")); return { props: { fill: color((_b = decl.fill) !== null && _b !== void 0 ? _b : el.getAttribute("fill"), warnings), draw: color((_c = decl.stroke) !== null && _c !== void 0 ? _c : el.getAttribute("stroke"), warnings), lineWidthPt: Number.isFinite(width) && width > 0 ? width : .4 } }; };
    const pathObject = (parsed, m, sty) => ({ id: newObjectId(), type: "path", start: apply(m, parsed.start), segments: parsed.segments.map(s => s.type === "line" ? { type: "line", to: apply(m, s.to) } : { type: "cubic", c1: apply(m, s.c1), c2: apply(m, s.c2), to: apply(m, s.to) }), closed: parsed.closed, style: sty });
    const visit = (el, parent) => {
        var _a;
        const m = multiply(parent, transformMatrix(el.getAttribute("transform"))), tag = el.localName.toLowerCase(), sty = style(el);
        if (tag === "g" || tag === "svg") {
            for (const child of Array.from(el.children))
                visit(child, m);
            return;
        }
        if (tag === "path") {
            const parsed = parseSvgPathData(el.getAttribute("d") || "");
            if (parsed) {
                objects.push(pathObject(parsed, m, sty));
                warnings.push(...(parsed.warnings || []));
            }
            return;
        }
        if (tag === "line") {
            objects.push(pathObject({ start: { x: num(el, "x1"), y: num(el, "y1") }, segments: [{ type: "line", to: { x: num(el, "x2"), y: num(el, "y2") } }], closed: false }, m, sty));
            return;
        }
        if (tag === "polyline" || tag === "polygon") {
            const values = ((_a = (el.getAttribute("points") || "").match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi)) === null || _a === void 0 ? void 0 : _a.map(Number)) || [];
            const pts = [];
            for (let j = 0; j + 1 < values.length; j += 2)
                pts.push({ x: values[j], y: values[j + 1] });
            if (pts.length)
                objects.push(pathObject({ start: pts[0], segments: pts.slice(1).map(to => ({ type: "line", to })), closed: tag === "polygon" }, m, sty));
            return;
        }
        if (tag === "rect") {
            const p = apply(m, { x: num(el, "x"), y: num(el, "y") }), q = apply(m, { x: num(el, "x") + num(el, "width"), y: num(el, "y") + num(el, "height") });
            objects.push({ id: newObjectId(), type: "rect", from: p, to: q, style: sty });
            if (m.b || m.c)
                warnings.push("Rotated rect transform was approximated");
            return;
        }
        if (tag === "circle" || tag === "ellipse") {
            const c = apply(m, { x: num(el, "cx"), y: num(el, "cy") }), rx = tag === "circle" ? num(el, "r") : num(el, "rx"), ry = tag === "circle" ? num(el, "r") : num(el, "ry");
            objects.push({ id: newObjectId(), type: "ellipse", center: c, rx: Math.abs(rx * m.a), ry: Math.abs(ry * m.d), style: sty });
            if (m.b || m.c)
                warnings.push(`Rotated ${tag} transform was approximated`);
            return;
        }
        if (tag === "text") {
            objects.push({ id: newObjectId(), type: "node", at: apply(m, { x: num(el, "x"), y: num(el, "y") }), latex: el.textContent || "", anchor: "center", style: sty });
            return;
        }
        warnings.push(`Unsupported SVG element <${tag}> was skipped`);
    };
    visit(root, identity);
    const pts = [];
    for (const o of objects) {
        if (o.type === "path")
            pts.push(o.start, ...o.segments.flatMap(s => s.type === "line" ? [s.to] : [s.c1, s.c2, s.to]));
        else if (o.type === "rect")
            pts.push(o.from, o.to);
        else if (o.type === "ellipse")
            pts.push({ x: o.center.x - o.rx, y: o.center.y - o.ry }, { x: o.center.x + o.rx, y: o.center.y + o.ry });
        else if (o.type === "node")
            pts.push(o.at);
    }
    if (!pts.length)
        return { objects, warnings };
    const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x)), minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y)), scale = targetWidth > 0 ? targetWidth / Math.max(maxX - minX, 1) : 1, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const convert = (p) => { p.x = (p.x - cx) * scale; p.y = -(p.y - cy) * scale; };
    for (const o of objects) {
        if (o.type === "path") {
            convert(o.start);
            o.segments.forEach(s => { convert(s.to); if (s.type === "cubic") {
                convert(s.c1);
                convert(s.c2);
            } });
        }
        else if (o.type === "rect") {
            convert(o.from);
            convert(o.to);
        }
        else if (o.type === "ellipse") {
            convert(o.center);
            o.rx *= scale;
            o.ry *= scale;
        }
        else if (o.type === "node")
            convert(o.at);
    }
    return { objects, warnings };
};
