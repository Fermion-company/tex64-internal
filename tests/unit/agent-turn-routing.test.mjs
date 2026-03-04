import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { deriveTurnRouting, deriveTurnTemperature } = require("../../electron/services/agent.cjs");

test("deriveTurnRouting: greeting-only never enters workspace mode", () => {
  const conversation = [
    { role: "user", parts: [{ text: "タイトルをhelloに変えて" }] },
    { role: "model", parts: [{ text: "了解" }] },
  ];
  const routing = deriveTurnRouting("こんにちは", conversation);
  assert.equal(routing.mode, "smalltalk");
  assert.equal(routing.useWorkspaceContext, false);
  assert.equal(routing.disableTools, true);
});

test("deriveTurnRouting: edit request enters workspace + forces edit tool call", () => {
  const routing = deriveTurnRouting("タイトルをこんにちはに変えて", []);
  assert.equal(routing.mode, "workspace");
  assert.equal(routing.useWorkspaceContext, true);
  assert.equal(routing.disableTools, false);
  assert.equal(routing.forceToolCall, "edit");
});

test("deriveTurnRouting: verification request enters workspace + forces build tool call", () => {
  const routing = deriveTurnRouting("ビルドして", []);
  assert.equal(routing.mode, "workspace");
  assert.equal(routing.forceToolCall, "build");
});

test("deriveTurnRouting: continuation cue keeps workspace when prior turns are workspace-like", () => {
  const conversation = [
    { role: "user", parts: [{ text: "タイトルをhelloに変えて" }] },
    { role: "model", parts: [{ text: "変更案を作成します。" }] },
    { role: "user", parts: [{ text: "OK" }] },
  ];
  const routing = deriveTurnRouting("OK", conversation);
  assert.equal(routing.mode, "workspace");
  assert.equal(routing.disableTools, false);
});

test("deriveTurnRouting: capability question stays standalone (no tools)", () => {
  const routing = deriveTurnRouting("あなたには何ができる？", []);
  assert.equal(routing.mode, "standalone");
  assert.equal(routing.useWorkspaceContext, false);
  assert.equal(routing.disableTools, true);
});

test("deriveTurnTemperature: ideation / drafting / verification presets", () => {
  const baseSettings = { temperature: 0.2 };

  const routingWorkspace = deriveTurnRouting("章構成の構成案を3案出して", []);
  const ideation = deriveTurnTemperature("章構成の構成案を3案出して", routingWorkspace, baseSettings);
  assert.equal(ideation.profile, "ideation");
  assert.ok(ideation.temperature >= 0.65 && ideation.temperature <= 0.8);

  const draftRouting = deriveTurnRouting("本文ドラフトを書いて", []);
  const draft = deriveTurnTemperature("本文ドラフトを書いて", draftRouting, baseSettings);
  assert.equal(draft.profile, "draft");
  assert.ok(draft.temperature >= 0.4 && draft.temperature <= 0.55);

  const verifyRouting = deriveTurnRouting("この範囲を校正して。意味は変えないで。", []);
  const verify = deriveTurnTemperature("この範囲を校正して。意味は変えないで。", verifyRouting, baseSettings);
  assert.equal(verify.profile, "verify");
  assert.ok(verify.temperature >= 0.1 && verify.temperature <= 0.25);
});
