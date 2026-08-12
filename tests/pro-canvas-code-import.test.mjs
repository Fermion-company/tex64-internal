import test from "node:test";
import assert from "node:assert/strict";
import { stripTikzWrapper } from "../Resources/web/app/pro-canvas/code-import.js";
test("stripTikzWrapper removes plain and optional wrappers",()=>{assert.equal(stripTikzWrapper("\\begin{tikzpicture}\n\\draw (0,0);\n\\end{tikzpicture}"),"\\draw (0,0);");assert.equal(stripTikzWrapper("\\begin{tikzpicture}[scale=2]\n  x\n\\end{tikzpicture}"),"x");assert.equal(stripTikzWrapper("  \\draw (0,0);  "),"\\draw (0,0);");});
