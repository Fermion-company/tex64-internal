import { resolveStyle } from "./scene.js";
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
    const customColors = new Map();
    let arrowsUsed = false;
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
        const keys = [];
        if (props.draw !== undefined && props.draw !== null && (explicitDraw || props.draw.toLowerCase() !== "#000000"))
            keys.push(`draw=${colorName(props.draw)}`);
        if (props.draw === null && explicitDraw)
            keys.push("draw=none");
        if (props.fill !== undefined && props.fill !== null)
            keys.push(`fill=${colorName(props.fill)}`);
        if (props.lineWidthPt !== undefined && props.lineWidthPt !== 0.4)
            keys.push(`line width=${numberText(props.lineWidthPt)}pt`);
        if (props.dash && props.dash !== "solid")
            keys.push(props.dash);
        if (props.opacity !== undefined && props.opacity < 1)
            keys.push(`opacity=${numberText(props.opacity)}`);
        const start = props.arrowStart || "";
        const end = props.arrowEnd || "";
        if (start || end) {
            arrowsUsed = true;
            keys.push(`${start ? `{${start}}` : ""}-${end ? `{${end}}` : ""}`);
        }
        if (props.cap && props.cap !== "butt")
            keys.push(`line cap=${props.cap}`);
        if (props.join && props.join !== "miter")
            keys.push(`line join=${props.join}`);
        if (props.roundedCornersPt !== undefined && props.roundedCornersPt > 0)
            keys.push(`rounded corners=${numberText(props.roundedCornersPt)}pt`);
        return keys;
    };
    const objectOptions = (style) => {
        if (style.ref)
            return [style.ref, ...styleKeys(style.props || {}, true)];
        return styleKeys(style.props || {});
    };
    const command = (object) => {
        const effective = resolveStyle(scene, object.style);
        if (effective.fill !== null && effective.draw === null)
            return "fill";
        if (effective.fill !== null && effective.draw !== null)
            return "filldraw";
        return "draw";
    };
    const withOptions = (name, options) => `\\${name}${options.length ? `[${options.join(", ")}]` : ""}`;
    const emitObject = (object, depth) => {
        const indent = "  ".repeat(depth);
        if (object.type === "group") {
            const t = object.transform;
            const transform = [];
            if (t.tx !== 0 || t.ty !== 0)
                transform.push(`shift={(${numberText(t.tx)},${numberText(t.ty)})}`);
            if (t.rotate !== 0)
                transform.push(`rotate=${numberText(t.rotate)}`);
            if (t.sx !== 1 || t.sy !== 1) {
                if (t.sx === t.sy)
                    transform.push(`scale=${numberText(t.sx)}`);
                else {
                    if (t.sx !== 1)
                        transform.push(`xscale=${numberText(t.sx)}`);
                    if (t.sy !== 1)
                        transform.push(`yscale=${numberText(t.sy)}`);
                }
            }
            if (!transform.length)
                return object.children.flatMap((child) => emitObject(child, depth));
            return [`${indent}\\begin{scope}[${transform.join(", ")}]`, ...object.children.flatMap((child) => emitObject(child, depth + 1)), `${indent}\\end{scope}`];
        }
        const options = objectOptions(object.style);
        if (object.type === "node") {
            if (object.anchor !== "center")
                options.unshift(`anchor=${object.anchor}`);
            return [`${indent}${withOptions("node", options)} at ${point(object.at)} {${object.latex}};`];
        }
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
    const body = scene.objects.flatMap((object) => emitObject(object, 1));
    const begin = `\\begin{tikzpicture}${pictureOptions.length ? `[${pictureOptions.join(", ")}]` : ""}`;
    const requires = arrowsUsed ? ["arrows.meta"] : [];
    const definitions = [...customColors].map(([hex, name]) => `\\definecolor{${name}}{HTML}{${hex.toUpperCase()}}`);
    const comment = requires.length ? [`% requires \\usetikzlibrary{${requires.join(",")}}`] : [];
    return { code: [...definitions, ...comment, begin, ...body, "\\end{tikzpicture}"].join("\n"), requires };
};
