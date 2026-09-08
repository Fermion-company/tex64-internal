"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const ts = require("typescript");
const { chromium } = require("playwright");

const compile = async file => ts.transpileModule(await fs.readFile(require.resolve(file), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;

test("closed diff dialogs leave the accessibility tree and return focus for single, read-only and multi-file views", async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const warnings = []; const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (/Blocked aria-hidden/.test(message.text())) warnings.push(message.text()); });
  await page.setContent(`<style>
    .modal { display:flex; opacity:0; pointer-events:none; position:fixed; inset:70px 0 0; }
    .modal.is-open { opacity:1; pointer-events:auto; }
  </style><button id="opener">Compare file</button><button id="editor">Editor</button>
  <div id="diffModal" class="modal" aria-hidden="true"><div role="dialog" aria-modal="true" aria-labelledby="diffTitle">
    <h2 id="diffTitle">Confirm changes</h2><span id="diffFileName"></span><span id="diffSummary"></span>
    <button id="diffModalCancel">Cancel</button><button id="diffModalSubmit">Confirm</button><div id="blockDiffContainer"></div>
  </div></div>`);
  await page.evaluate(({ diff, modal }) => {
    const diffExports = {}; new Function("exports", diff)(diffExports);
    const modalExports = {}; new Function("exports", "require", modal)(modalExports, () => diffExports);
    const dom = Object.fromEntries(["diffModal", "diffTitle", "diffFileName", "diffSummary", "diffModalCancel", "diffModalSubmit", "blockDiffContainer"].map(id => [id, document.getElementById(id)]));
    window.revealedLines = [];
    const part = { updateOptions() {}, revealLine(line) { window.revealedLines.push(line); }, getContentHeight: () => 60 };
    const monaco = { editor: { createModel: () => ({ dispose() {} }), createDiffEditor: () => ({
      setModel() {}, layout() {}, dispose() {}, getOriginalEditor: () => part, getModifiedEditor: () => part,
    }) } };
    window.diffApi = modalExports.initDiffModal({ dom }, { getMonacoApi: () => monaco, getActiveFilePath: () => "main.tex" });
    dom.diffModalCancel.addEventListener("click", () => window.diffApi.closeDiffModal());
  }, { diff: await compile("../web-src/app/diff.ts"), modal: await compile("../web-src/app/diff-modal.ts") });
  assert.equal(await page.locator("#diffModal").evaluate(el => el.inert), true);
  const cdp = await page.context().newCDPSession(page);
  const assertClosed = async expectedFocus => {
    assert.equal(await page.evaluate(() => document.activeElement.id || document.activeElement.tagName), expectedFocus);
    assert.equal(await page.locator("#diffModal").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#diffModal").evaluate(el => el.inert), true);
    const tree = await cdp.send("Accessibility.getFullAXTree");
    assert.equal(tree.nodes.some(node => !node.ignored && node.role?.value === "dialog"), false);
  };
  await assertClosed("BODY");
  for (const kind of ["normal", "viewOnly", "multi"]) {
    await page.locator("#opener").focus();
    await page.evaluate(kind => {
      if (kind === "multi") window.diffApi.showMultiFileDiff([{ fileName: "a.tex", original: "a", modified: "b" }, { fileName: "b.tex", original: "x", modified: "y" }], { viewOnly: true });
      else window.diffApi.showDiffModal("a", "b", 0, { viewOnly: kind === "viewOnly" });
    }, kind);
    assert.equal(await page.locator("#diffModal").evaluate(el => el.inert), false);
    await page.locator("#diffModalCancel").click();
    await assertClosed("opener");
  }
  await page.locator("#opener").focus();
  await page.evaluate(() => {
    document.body.setAttribute("tabindex", "-1");
    window.diffApi.showDiffModal("a", "b", 0, { viewOnly: true });
    document.getElementById("opener").remove(); // History rerender removed the initiating button.
  });
  await page.locator("#diffModalCancel").click();
  await assertClosed("BODY");
  assert.equal(await page.locator("body").getAttribute("tabindex"), "-1");
  await page.evaluate(() => document.body.removeAttribute("tabindex"));
  await page.locator("#editor").focus();
  await page.evaluate(() => {
    window.diffApi.showDiffModal("a", "b");
    document.getElementById("editor").hidden = true;
  });
  await page.locator("#diffModalCancel").click();
  await assertClosed("BODY");
  assert.equal(await page.locator("body").getAttribute("tabindex"), null);
  await page.evaluate(() => {
    const editor = document.getElementById("editor"); editor.hidden = false;
    editor.focus(); window.diffApi.showDiffModal("a", "b");
    const applied = document.createElement("button"); applied.id = "applied-editor"; applied.textContent = "Applied text"; document.body.append(applied);
    applied.focus(); // An apply handler deliberately focused the edited destination.
    window.diffApi.closeDiffModal();
  });
  await assertClosed("applied-editor");
  // Deterministically cross the queued reveal frame after immediate close.
  await page.evaluate(async () => {
    window.revealedLines = [];
    window.diffApi.showDiffModal("old", "changed");
    window.diffApi.closeDiffModal();
    await new Promise(requestAnimationFrame);
  });
  assert.deepEqual(await page.evaluate(() => window.revealedLines), []);
  // A newer comparison reuses the same Monaco editor; the older callback
  // must not scroll that new document using the previous comparison's lines.
  await page.evaluate(async () => {
    window.revealedLines = [];
    window.diffApi.showDiffModal("old", "changed");
    const prefix = Array(10).fill("same").join("\n") + "\n";
    window.diffApi.showDiffModal(prefix + "old", prefix + "changed");
    await new Promise(requestAnimationFrame);
  });
  assert.deepEqual(await page.evaluate(() => window.revealedLines), [9]);
  await page.locator("#diffModalCancel").click();
  assert.deepEqual(warnings, []);
  assert.deepEqual(pageErrors, []);
});

test("custom diff apply edits the current model once, preserves failure/retry and never invokes block/AI handlers", async t => {
 const browser=await chromium.launch({headless:true}); t.after(()=>browser.close()); const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<div id="diffModal"><h2 id="diffTitle"></h2><span id="diffFileName"></span><span id="diffSummary"></span><button id="diffModalCancel">Cancel</button><button id="diffModalSubmit">Confirm</button><div id="blockDiffContainer"></div></div>');
 await page.evaluate(({diff,modal,events,workspace})=>{
   const d={}; new Function('exports',diff)(d); const m={}; new Function('exports','require',modal)(m,()=>d); const e={}; new Function('exports',events)(e);
   const dom=Object.fromEntries(['diffModal','diffTitle','diffFileName','diffSummary','diffModalCancel','diffModalSubmit','blockDiffContainer'].map(id=>[id,document.getElementById(id)])); dom.tabs=[];
   window.counts={block:0,ai:0,clear:0,apply:0}; window.readOnly=true;
   const monaco={editor:{createModel:(value)=>({getValue:()=>value,dispose(){}}),createDiffEditor:()=>({setModel(model){window.model=model;},updateOptions(o){if (Object.hasOwn(o,"readOnly")) window.readOnly=o.readOnly;},dispose(){},layout(){}})}};
   window.api=m.initDiffModal({dom},{getMonacoApi:()=>monaco,getActiveFilePath:()=>null});
   const w={};new Function('exports','require',workspace)(w,()=>({getUiLocale:()=> 'ja'}));
   const noop=()=>{};
   window.workspace=w.initWorkspaceController({dom:{}},{setWorkspaceRootKey:noop,settingsUi:{refreshCompileEngine:noop,loadWorkspaceSettings:noop},launcherUi:{setVisible:noop,setStatus:noop},buildOps:{updateSynctexButtonState:noop},editorSession:{syncWorkspaceFiles:noop,requestInitialOpen:noop},searchUi:{reset:noop},diffModal:window.api,envRegistry:{reload:noop},rootSelectorUi:{render:noop},setLastBuildMainFile:noop});
   window.workspace.handleWorkspaceUpdate({rootName:'A',rootPath:'/A',files:['main.tex']});
   e.initUiEvents({dom},{diffModal:window.api,blockInsert:{applyPendingFromDiffModal(){window.counts.block++;},clearPending(){window.counts.clear++;}},aiOps:{applyPendingFromDiffModal(){window.counts.ai++;},clearPending(){window.counts.clear++;}},buildOps:{setupActionButtons(){}},rootSelectorUi:{setupActions(){}},saveCurrentFile(){}}).setup();
   window.api.showDiffModal('base','conflict',0,{onApply:async content=>{window.counts.apply++;window.applied=content;await new Promise(resolve=>window.release=resolve);}});
   window.model.modified.getValue=()=> 'resolved';
 },{diff:await compile('../web-src/app/diff.ts'),modal:await compile('../web-src/app/diff-modal.ts'),events:await compile('../web-src/app/ui-events.ts'),workspace:await compile('../web-src/app/workspace-controller.ts')});
 assert.equal(await page.evaluate(()=>window.readOnly),false);
 await page.keyboard.press('Enter'); assert.equal(await page.evaluate(()=>window.counts.apply),0);
 await page.locator('#diffModalSubmit').click(); await page.evaluate(()=>document.getElementById('diffModalSubmit').click()); assert.equal(await page.evaluate(()=>window.counts.apply),1); assert.equal(await page.evaluate(()=>window.applied),'resolved');
 // Git's save acknowledgement refreshes the same workspace before apply returns.
 await page.evaluate(()=>window.workspace.handleWorkspaceUpdate({rootName:'A',rootPath:'/A',files:['main.tex']}));
 assert.equal(await page.evaluate(()=>window.api.getDiffContext()?.type),'customApply');
 await page.evaluate(()=>window.release()); await page.waitForFunction(()=>!document.getElementById('diffModal').classList.contains('is-open'));
 await page.evaluate(()=>window.api.showDiffModal('a','b',0,{onApply:async()=>{throw new Error('STATE_CHANGED');}})); await page.locator('#diffModalSubmit').click(); await page.waitForFunction(()=>document.getElementById('diffSummary').textContent==='STATE_CHANGED'); assert.equal(await page.locator('#diffModalSubmit').isDisabled(),false);
 await page.locator('#diffModalCancel').click(); assert.equal(await page.evaluate(()=>window.counts.clear),0);
 // A late completion cannot close a new comparison or dispatch to its handler.
 await page.evaluate(()=>window.api.showDiffModal('a','b',0,{onApply:()=>new Promise(resolve=>window.release=resolve)})); await page.locator('#diffModalSubmit').click(); await page.locator('#diffModalCancel').click();
 await page.evaluate(()=>{window.api.showDiffModal('block','insert');window.release();}); await page.waitForTimeout(20); assert.equal(await page.evaluate(()=>document.getElementById('diffModal').classList.contains('is-open')),true); assert.equal(await page.evaluate(()=>window.readOnly),true);
 await page.locator('#diffModalSubmit').click();
 await page.evaluate(()=>{window.api.setDiffContext({type:'aiApply',proposalIds:[]});window.api.showDiffModal('ai','apply');}); await page.locator('#diffModalSubmit').click();
 await page.evaluate(()=>{window.api.showDiffModal('a','b',0,{onApply:async()=>{}});window.workspace.handleWorkspaceUpdate({rootName:'B',rootPath:'/B',files:[]});});
 assert.equal(await page.evaluate(()=>document.getElementById('diffModal').classList.contains('is-open')),false);
 assert.deepEqual(await page.evaluate(()=>window.counts),{block:1,ai:1,clear:0,apply:1}); assert.deepEqual(errors,[]);
});
