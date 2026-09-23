'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const ts=require('typescript');
const {chromium}=require('playwright');
for (const identityReady of [true, false]) test(`Git UI refresh and workspace binding (initial identity ${identityReady})`,async t=>{
 const browser=await chromium.launch({headless:true}); t.after(()=>browser.close()); const page=await browser.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<div id="git-panel"></div>');
 const code=ts.transpileModule(await fs.readFile(require.resolve('../web-src/app/git-ui.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 await page.evaluate(({code,identityReady})=>{
  window.identity='A';window.statusCalls=0;window.entries=[];window.changed=false;
  window.tex64Git={getIdentity:()=>identityReady?({workspaceId:window.identity,workspaceGeneration:1}):({}),onChange(fn){window.notify=fn;return()=>{};},async call(action){
    if(action!=='status')throw new Error('Unexpected '+action);window.statusCalls++; if(window.staleOnce){window.staleOnce=false;return {ok:false,code:'STALE_WORKSPACE'};}
    return {ok:true,workspaceId:window.identity,phase:'idle',state:{repository:true,supported:true,branch:window.identity==='A'?'main':'other',branchRef:'refs/heads/main',refs:[{name:'refs/heads/main',oid:'a'},{name:'refs/heads/side',oid:'b'}],status:{entries:window.entries,hasStaged:false},remotes:[]}};
  }};
  const exported={};new Function('exports','require',code)(exported,name=>name.includes('actions-menu')?{createActionsMenu(buttons){const div=document.createElement('div');div.append(...buttons);return div;}}:name.includes('editor-operation-guard')?{getEditorOperationGuard(){return {setLocked(){},refresh(){}};}}:{uiText:(en,ja)=>ja});
  exported.initGitUi({}, {getDiffContext:()=>null,closeDiffModal(){}});
 },{code,identityReady});
 if(!identityReady){await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>window.statusCalls),0);await page.evaluate(()=>window.notify({type:"updateWorkspace",payload:{workspaceId:"A",workspaceGeneration:1}}));}
 await page.waitForFunction(()=>window.statusCalls===1 && document.getElementById('git-panel').textContent.includes('変更なし'));
 await page.evaluate(()=>{window.entries=[{path:'main.tex',staged:false,unstaged:true,index:'.',worktree:'M'}];for(let i=0;i<20;i++)window.notify({type:'saveResult',payload:{ok:true}});});
 await page.waitForFunction(()=>document.querySelector('.git-file-name')?.textContent==='main.tex');assert.equal(await page.evaluate(()=>window.statusCalls),2);
 await page.evaluate(()=>window.notify({type:'saveResult',payload:{ok:false}}));await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.statusCalls),2);
 await page.evaluate(()=>{document.querySelector('#git-panel > .history-error').textContent='操作結果';window.entries=[];window.notify({type:'file:externalChange',payload:{workspaceId:'A'}});});await page.waitForFunction(()=>window.statusCalls===3); assert.equal(await page.locator('#git-panel > .history-error').textContent(),'操作結果');
 await page.getByRole('button',{name:'main ▾',exact:true}).click();assert.equal(await page.locator('dialog[open]').count(),1);
 await page.evaluate(()=>{window.identity='B';window.notify({type:'updateWorkspace',payload:{workspaceId:'B'}});});
 await page.waitForFunction(()=>!document.querySelector('dialog[open]'));await page.waitForFunction(()=>document.querySelector('.history-heading').textContent.includes('other'));await page.evaluate(()=>{window.staleOnce=true;window.notify({type:'file:externalChange',payload:{}});}); await page.waitForFunction(()=>document.querySelector('#git-panel > .history-error').textContent.includes('プロジェクトが変わりました')); await page.evaluate(()=>window.notify({type:'file:externalChange',payload:{}})); await page.waitForFunction(()=>document.querySelector('#git-panel > .history-error').textContent===''); assert.deepEqual(errors,[]);
});

test('Git UI reads status only while its panel is shown, and catches up when it opens',async t=>{
 const browser=await chromium.launch({headless:true}); t.after(()=>browser.close()); const page=await browser.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<div class="panel" data-panel="git"><div id="git-panel"></div></div>');
 const code=ts.transpileModule(await fs.readFile(require.resolve('../web-src/app/git-ui.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 await page.evaluate(({code})=>{
  window.statusCalls=0;
  window.tex64Git={getIdentity:()=>({workspaceId:'A',workspaceGeneration:1}),onChange(fn){window.notify=fn;return()=>{};},async call(action){
    if(action!=='status')throw new Error('Unexpected '+action);window.statusCalls++;
    return {ok:true,workspaceId:'A',phase:'idle',state:{repository:true,supported:true,branch:'main',branchRef:'refs/heads/main',refs:[{name:'refs/heads/main',oid:'a'}],status:{entries:[],hasStaged:false},remotes:[]}};
  }};
  const exported={};new Function('exports','require',code)(exported,name=>name.includes('actions-menu')?{createActionsMenu(buttons){const div=document.createElement('div');div.append(...buttons);return div;}}:name.includes('editor-operation-guard')?{getEditorOperationGuard(){return {setLocked(){},refresh(){}};}}:{uiText:(en,ja)=>ja});
  exported.initGitUi({}, {getDiffContext:()=>null,closeDiffModal(){}});
 },{code});
 await page.evaluate(()=>{for(let i=0;i<5;i++)window.notify({type:'saveResult',payload:{ok:true}});window.notify({type:'file:externalChange',payload:{workspaceId:'A'}});});
 await page.waitForTimeout(400); assert.equal(await page.evaluate(()=>window.statusCalls),0,'hidden panel spawns no status read');
 await page.evaluate(()=>document.querySelector('.panel').classList.add('is-active'));
 await page.waitForFunction(()=>window.statusCalls===1); await page.waitForTimeout(300); assert.equal(await page.evaluate(()=>window.statusCalls),1,'one catch-up read when shown');
 await page.evaluate(()=>window.notify({type:'saveResult',payload:{ok:true}}));
 await page.waitForFunction(()=>window.statusCalls===2);
 await page.evaluate(()=>{document.querySelector('.panel').classList.remove('is-active');window.notify({type:'saveResult',payload:{ok:true}});});
 await page.waitForTimeout(400); assert.equal(await page.evaluate(()=>window.statusCalls),2,'hidden again: no read');
 assert.deepEqual(errors,[]);
});
