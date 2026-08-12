import type { Scene } from "./scene.js";
import { generateTikz } from "./tikz-generate.js";

export const buildStandaloneDoc = (scene: Scene, options?: { preamble?: string }): string => {
  const generated = generateTikz(scene);
  const code = generated.code
    .split("\n")
    .filter((line) => !/^% requires(?:\s|$)/.test(line))
    .flatMap((line) => /^\\begin\{tikzpicture\}(?:\[.*\])?$/.test(line)
      ? [line, `  \\useasboundingbox (0,0) rectangle (${scene.width},${scene.height});`]
      : [line])
    .join("\n");
  const libraries = generated.requires.length ? `\\usetikzlibrary{${generated.requires.join(",")}}\n` : "";
  const preamble = options?.preamble ? `${options.preamble}\n` : "";
  return `\\documentclass[margin=0pt]{standalone}\n\\usepackage{tikz}\n${libraries}${preamble}\\begin{document}\n${code}\n\\end{document}`;
};
