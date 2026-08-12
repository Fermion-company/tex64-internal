import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPL3_COMMAND_PATTERN,
  EXPL3_VARIABLE_PATTERN,
  LATEX_MONARCH,
} from "../web-src/app/monaco-language.ts";

const matchesEntire = (pattern, value) => {
  const match = value.match(pattern);
  return match?.[0] === value;
};

test("expl3 command pattern recognizes a complete function signature", () => {
  for (const command of [
    "\\cs_new:Npn",
    "\\tl_set:Nn",
    "\\prop_get:cnNTF",
    "\\__module_private:Vw",
    "\\scan_stop:",
    "\\prg_return_true:",
    "\\scan_stop:x",
  ]) {
    assert.equal(matchesEntire(EXPL3_COMMAND_PATTERN, command), true, command);
  }

  for (const command of ["\\section", "\\foo:nn", "\\foo_bar:q"]) {
    assert.equal(matchesEntire(EXPL3_COMMAND_PATTERN, command), false, command);
  }
});

test("expl3 variable pattern recognizes scoped variables with known type suffixes", () => {
  for (const variable of [
    "\\l_tmpa_tl",
    "\\g_module_items_seq",
    "\\c_zero_int",
    "\\l_pdf_width_dim",
    "\\g_options_prop",
  ]) {
    assert.equal(matchesEntire(EXPL3_VARIABLE_PATTERN, variable), true, variable);
  }

  for (const variable of ["\\foo_tl", "\\l_missingtype", "\\x_tmpa_tl", "\\l_tmpa_xyz"]) {
    assert.equal(matchesEntire(EXPL3_VARIABLE_PATTERN, variable), false, variable);
  }
});

test("expl3 rules precede the ordinary LaTeX command fallback", () => {
  const root = LATEX_MONARCH.tokenizer.root;
  const commandRule = root.findIndex((rule) => rule[0] === EXPL3_COMMAND_PATTERN);
  const variableRule = root.findIndex((rule) => rule[0] === EXPL3_VARIABLE_PATTERN);
  const fallbackRule = root.findIndex((rule) => String(rule[0]) === String(/\\[a-zA-Z@]+/));

  assert.ok(commandRule >= 0 && commandRule < fallbackRule);
  assert.ok(variableRule >= 0 && variableRule < fallbackRule);
  assert.equal(root[commandRule][1], "support.function.expl3");
  assert.equal(root[variableRule][1], "variable.expl3");
});

test("Lua entry rules use embedded Lua and expose nested directlua states", () => {
  const root = LATEX_MONARCH.tokenizer.root;
  const embeddedActions = root
    .flatMap((rule) => (Array.isArray(rule[1]) ? rule[1] : [rule[1]]))
    .filter((action) => action && typeof action === "object" && action.nextEmbedded === "lua");

  assert.equal(embeddedActions.length, 2);
  assert.deepEqual(embeddedActions.map((action) => action.next), ["@luaCode", "@directLua"]);
  assert.ok(LATEX_MONARCH.tokenizer.directLuaNested);
  assert.equal(LATEX_MONARCH.tokenizer.directLuaNested[2][1].nextEmbedded, undefined);
  assert.equal(LATEX_MONARCH.tokenizer.directLua[2][1].nextEmbedded, "@pop");
  assert.equal(LATEX_MONARCH.tokenizer.luaCode[0][1][4].nextEmbedded, "@pop");
});
