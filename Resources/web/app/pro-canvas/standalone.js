import { generateTikz } from "./tikz-generate.js";
export const buildStandaloneDoc = (scene) => {
    const generated = generateTikz(scene);
    const code = generated.code
        .split("\n")
        .filter((line) => !/^% requires(?:\s|$)/.test(line))
        .flatMap((line) => /^\\begin\{tikzpicture\}(?:\[.*\])?$/.test(line)
        ? [line, `  \\useasboundingbox (0,0) rectangle (${scene.width},${scene.height});`]
        : [line])
        .join("\n");
    const libraries = generated.requires.length ? `\\usetikzlibrary{${generated.requires.join(",")}}\n` : "";
    return `\\documentclass[margin=0pt]{standalone}\n\\usepackage{tikz}\n${libraries}\\begin{document}\n${code}\n\\end{document}`;
};
