import { sceneHasPlot } from "./scene.js";
import { generateTikz } from "./tikz-generate.js";
export const buildStandaloneDoc = (scene, options) => {
    var _a, _b;
    const generated = generateTikz(scene);
    const code = generated.code
        .split("\n")
        .filter((line) => !/^% requires(?::|\s|$)/.test(line))
        .flatMap((line) => /^\\begin\{tikzpicture\}(?:\[.*\])?$/.test(line)
        ? [line, `  \\useasboundingbox (0,0) rectangle (${scene.width},${scene.height});`]
        : [line])
        .join("\n");
    const libraries = generated.requires.length ? `\\usetikzlibrary{${generated.requires.join(",")}}\n` : "";
    const preamble = (options === null || options === void 0 ? void 0 : options.preamble) ? `${options.preamble}\n` : "";
    const pgfplots = sceneHasPlot(scene) ? `${((_a = options === null || options === void 0 ? void 0 : options.preamble) === null || _a === void 0 ? void 0 : _a.includes("pgfplots")) ? "" : "\\usepackage{pgfplots}\n"}${((_b = options === null || options === void 0 ? void 0 : options.preamble) === null || _b === void 0 ? void 0 : _b.includes("\\pgfplotsset")) ? "" : "\\pgfplotsset{compat=1.18}\n"}` : "";
    return `\\documentclass[margin=0pt]{standalone}\n\\usepackage{tikz}\n${libraries}${pgfplots}${preamble}\\begin{document}\n${code}\n\\end{document}`;
};
