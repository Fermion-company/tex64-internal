"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitRunner } = require('../electron/services/git-runner.cjs');
const { GitService } = require('../electron/services/git-service.cjs');
const binary = process.env.TEX64_TEST_GIT || '/usr/bin/git';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tex64-git-service-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const env = {...process.env, HOME:root, XDG_CONFIG_HOME:root, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null'};
  const git = (...args) => execFileSync(binary,args,{cwd:root,env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trimEnd();
  git('init','--quiet','--initial-branch=main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  const runner = new GitRunner({root,binaryPath:binary,env}); const calls=[];
  const service = new GitService({runner,withMutation:async (meta, callback) => {
    calls.push(meta); const result=await callback(); assert.equal(await meta.verify({result}),result.completion); return result;
  }});
  const write = (file,contents) => fs.writeFile(path.join(root,file),contents);
  const act = async (action,args) => service.execute((await service.plan(action,args)).planId);
  const base = async () => { await write('main.tex','base\n'); git('add','main.tex'); git('commit','--quiet','-m','base'); };
  return {root,git,runner,service,calls,write,act,base};
}
test('index-only commit preserves partial staging; whole-file stage is explicit and unstage preserves bytes',async t=>{
 const f=await fixture(t); await f.base(); await f.write('main.tex','base\nstaged\n'); f.git('add','main.tex'); await f.write('main.tex','base\nstaged\nremaining\n');
 await f.act('commit',{message:'index only'}); assert.equal(f.git('show','HEAD:main.tex'),'base\nstaged'); assert.equal(await fs.readFile(path.join(f.root,'main.tex'),'utf8'),'base\nstaged\nremaining\n');
 await f.act('stage',{paths:['main.tex']}); await f.write('main.tex','base\nstaged\nremaining\nnext\n');
 const p=await f.service.plan('stage',{paths:['main.tex']}); assert.match(p.review.details.join(' '),/残り/); await f.service.execute(p.planId);
 await f.act('unstage',{paths:['main.tex']}); assert.equal((await f.service.status()).status.hasStaged,false); assert.match(await fs.readFile(path.join(f.root,'main.tex'),'utf8'),/next/);
 assert(f.calls.every(c=>typeof c.verify==='function' && !c.writesWorktree));
});
test('unborn unstage and literal magic/newline filenames do not affect other files',async t=>{
 const f=await fixture(t); const name=':(glob)*\n.tex'; await f.write(name,'literal'); await f.write('other.tex','other');
 await f.act('stage',{paths:[name]}); assert.deepEqual(f.git('ls-files','-z').split('\0').filter(Boolean),[name]);
 await f.act('unstage',{paths:[name]}); assert.equal(f.git('ls-files','-z'),''); assert.equal(await fs.readFile(path.join(f.root,name),'utf8'),'literal');
 await f.act('stage',{paths:[name]}); await f.act('commit',{message:'first'}); assert.equal((await f.service.status()).unborn,false);
});
test('create/switch uses explicit refs, dirty protection and annotated immutable tags',async t=>{
 const f=await fixture(t); await f.base(); const head=f.git('rev-parse','HEAD'); await f.write('main.tex','dirty\n');
 await f.act('branch-create',{name:'codex/side'}); assert.equal(f.git('branch','--show-current'),'codex/side');
 await assert.rejects(f.service.plan('branch-switch',{ref:'refs/heads/main'}),{code:'GIT_DIRTY'});
 await f.act('stage',{paths:['main.tex']}); await f.act('commit',{message:'side'}); await f.act('branch-switch',{ref:'refs/heads/main'}); assert.equal(f.git('rev-parse','HEAD'),head);
 await f.act('tag-create',{name:'v1',message:'release'}); assert.equal(f.git('cat-file','-t','refs/tags/v1'),'tag'); assert.equal(f.git('rev-parse','v1^{commit}'),head);
 await assert.rejects(f.service.plan('tag-create',{name:'v1'}),{code:'GIT_REF_EXISTS'});
});
async function branches(f,conflict=false) {
 await f.base(); f.git('switch','--quiet','-c','side'); await f.write(conflict?'main.tex':'side.tex','side\n'); f.git('add','--all'); f.git('commit','--quiet','-m','side'); f.git('switch','--quiet','main');
}
test('fast-forward verifies target HEAD; divergent clean merge waits for explicit finish',async t=>{
 const f=await fixture(t); await branches(f); const target=f.git('rev-parse','side');
 const review=await f.service.plan('merge',{ref:'refs/heads/side'}); assert.deepEqual(review.review.details,['side を main に統合']); const ff=await f.service.execute(review.planId); assert.equal(ff.completion,'completed'); assert.equal(f.git('rev-parse','HEAD'),target);
 f.git('switch','--quiet','side'); await f.write('side.tex','side next\n'); f.git('commit','--quiet','-am','side next'); f.git('switch','--quiet','main'); await f.write('main.tex','main next\n'); f.git('commit','--quiet','-am','main next');
 const before=f.git('rev-parse','HEAD'), other=f.git('rev-parse','side'); const pending=await f.act('merge',{ref:'refs/heads/side'}); assert.equal(pending.completion,'conflict'); assert.equal(pending.conflict,false); assert.equal(f.git('rev-parse','HEAD'),before);
 await f.act('merge-finish',{message:'merge reviewed'}); assert.deepEqual(f.git('rev-list','--parents','-n','1','HEAD').split(' ').slice(1),[before,other]);
});
test('conflict resolve/finish and abort retain explicit merge lifecycle',async t=>{
 const f=await fixture(t); await branches(f,true); await f.write('main.tex','main\n'); f.git('commit','--quiet','-am','main'); const before=f.git('rev-parse','HEAD');
 let result=await f.act('merge',{ref:'refs/heads/side'}); assert.equal(result.conflict,true);
 await assert.rejects(f.service.plan('merge-finish',{message:'bad'}),{code:'GIT_UNMERGED'});
 await f.write('main.tex','resolved\n'); result=await f.act('resolve-stage',{paths:['main.tex']}); assert.equal(result.conflict,false); assert.equal(result.completion,'conflict');
 await f.act('merge-abort'); assert.equal(f.git('rev-parse','HEAD'),before); assert.equal(await fs.readFile(path.join(f.root,'main.tex'),'utf8'),'main\n');
 await f.act('merge',{ref:'refs/heads/side'}); await f.write('main.tex','resolved again\n'); await f.act('resolve-stage',{paths:['main.tex']}); await f.act('merge-finish',{message:'resolved'}); assert.equal(f.git('show','HEAD:main.tex'),'resolved again');
});
test('plans are single-use and reject content/index/ref changes before any command',async t=>{
 const f=await fixture(t); await f.base(); await f.write('main.tex','edit1\n'); let p=await f.service.plan('stage',{paths:['main.tex']}); await f.write('main.tex','edit2\n'); await assert.rejects(f.service.execute(p.planId),{code:'STATE_CHANGED'}); assert.equal(f.git('diff','--cached','--name-only'),'');
 p=await f.service.plan('stage',{paths:['main.tex']}); await f.service.execute(p.planId); await assert.rejects(f.service.execute(p.planId),{code:'GIT_PLAN_EXPIRED'});
 p=await f.service.plan('commit',{message:'reviewed'}); await f.write('other.tex','other'); f.git('add','other.tex'); await assert.rejects(f.service.execute(p.planId),{code:'STATE_CHANGED'});
 p=await f.service.plan('commit',{message:'reviewed'}); f.git('branch','external'); await assert.rejects(f.service.execute(p.planId),{code:'STATE_CHANGED'});
});
test('invalid paths/refs, missing guard, author and executable hooks/signatures fail safely',async t=>{
 const f=await fixture(t); await f.base();
 for(const value of ['../outside','/tmp/file','.git/config','a/../b','a\\b','a//b']) await assert.rejects(f.service.plan('stage',{paths:[value]}),{code:'GIT_PATH_INVALID'});
 for(const name of ['--force','x..y','refs/heads/x','a.lock']) await assert.rejects(f.service.plan('branch-create',{name}),{code:'GIT_REF_INVALID'});
 await assert.rejects(f.service.plan('branch-switch',{ref:'main'}),{code:'GIT_REF_INVALID'});
 await f.write('main.tex','edit'); const unguarded=new GitService({runner:f.runner}); const p=await unguarded.plan('stage',{paths:['main.tex']}); await assert.rejects(unguarded.execute(p.planId),{code:'GIT_MUTATION_GUARD_REQUIRED'});
 await f.act('stage',{paths:['main.tex']}); f.git('config','--unset','user.name'); await assert.rejects(f.service.plan('commit',{message:'commit'}),{code:'GIT_AUTHOR_REQUIRED'}); f.git('config','user.name','Fixture');
 const hook=path.join(f.root,'.git/hooks/pre-commit'); await fs.writeFile(hook,'#!/bin/sh\nexit 91\n',{mode:0o755}); await assert.rejects(f.service.plan('commit',{message:'commit'}),{code:'GIT_HOOKS_UNTRUSTED'}); await fs.unlink(hook);
 f.git('config','commit.gpgSign','true'); await assert.rejects(f.service.plan('commit',{message:'commit'}),{code:'GIT_SIGNING_REQUIRED'}); assert.equal(f.git('log','-1','--format=%s'),'base');
});

test('custom merge options and forced annotated signing cannot execute implicitly',async t=>{
 const f=await fixture(t); await f.base(); f.git('branch','side');
 f.git('config','branch.main.mergeOptions','--strategy=external'); await assert.rejects(f.service.plan('merge',{ref:'refs/heads/side'}),{code:'GIT_EXECUTABLE_CONFIG'}); f.git('config','--unset','branch.main.mergeOptions');
 f.git('config','tag.forceSignAnnotated','true'); await assert.rejects(f.service.plan('tag-create',{name:'v1'}),{code:'GIT_SIGNING_REQUIRED'});
 // Explicit end-of-options keeps an existing dash-prefixed ref out of Git's option parser.
 f.git('update-ref','refs/heads/--discard-changes','HEAD'); await assert.rejects(f.service.plan('branch-switch',{ref:'refs/heads/--discard-changes'}).then(p=>f.service.execute(p.planId)));
 assert.equal(f.git('branch','--show-current'),'main');
});

test('unused filter registration permits real stage/commit, but a filtered target branch cannot execute smudge',async t=>{
 const f=await fixture(t); await f.base(); const marker=path.join(f.root,'must-not-filter');
 f.git('config','filter.sentinel.clean',`touch '${marker}'; cat`); f.git('config','filter.sentinel.smudge',`touch '${marker}'; cat`);
 await f.write('main.tex','edit\n'); await f.act('stage',{paths:['main.tex']}); await f.act('commit',{message:'safe without filter attributes'}); await assert.rejects(fs.access(marker));
 f.git('switch','--quiet','-c','filtered'); await f.write('.gitattributes','*.tex filter=sentinel\n'); f.git('-c','filter.sentinel.clean=cat','add','.gitattributes'); f.git('-c','filter.sentinel.clean=cat','commit','--quiet','-m','attrs'); f.git('-c','filter.sentinel.clean=cat','-c','filter.sentinel.smudge=cat','switch','--quiet','main');
 await assert.rejects(f.service.plan('branch-switch',{ref:'refs/heads/filtered'}),{code:'GIT_FILTER_UNTRUSTED'}); assert.equal(f.git('branch','--show-current'),'main'); await assert.rejects(fs.access(marker));
});

test('merge cannot combine a target attribute with an ours-only file to invoke a filter',async t=>{
 const f=await fixture(t); await f.base(); f.git('switch','--quiet','-c','attributes'); await f.write('.gitattributes','*.dat filter=sentinel\n'); f.git('add','.gitattributes'); f.git('commit','--quiet','-m','attrs'); f.git('switch','--quiet','main'); await f.write('ours.dat','data'); f.git('add','ours.dat'); f.git('commit','--quiet','-m','ours');
 const marker=path.join(f.root,'sentinel'); f.git('config','filter.sentinel.smudge',`touch '${marker}'; cat`);
 await assert.rejects(f.service.plan('merge',{ref:'refs/heads/attributes'}),{code:'GIT_FILTER_UNTRUSTED'}); await assert.rejects(fs.access(marker));
});
