"use strict";
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');

function createEducationService({app,BrowserWindow,dialog,getMainWindow,getRoot,openProject}) {
  const root=process.env.SCORING64_ROOT || path.resolve(__dirname,'../../../Scoring64');
  const python=process.env.SCORING64_PYTHON || path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  const data=process.env.SCORING64_DATA || path.join(app.getPath('userData'),'scoring');
  const instance=randomUUID();
  let child=null,ready=null,scoringWindow=null,busy=false;
  const tasks=new Set();
  const env=()=>({...process.env,SCORING64_DATA:data,TEX64_EDITION:'education',SCORING64_INSTANCE:instance,PYTHONPATH:path.join(root,'backend'),PATH:process.platform==='darwin'?'/Library/TeX/texbin:'+process.env.PATH:process.env.PATH});
  function checkRuntime() {
    if(!fs.existsSync(python)||!fs.existsSync(path.join(root,'frontend/dist/index.html')))throw Error('Educationの採点ランタイムがありません。Scoring64の依存と画面をビルドしてください。');
  }
  async function start() {
    if(ready)return ready;
    ready=(async()=>{
      checkRuntime();
      child=spawn(python,[path.join(root,'scripts/education_backend.py')],{cwd:root,env:env(),stdio:['ignore','pipe','pipe']});
      const running=child;
      running.once('exit',()=>{if(child===running){child=null;ready=null;}});
      let errorLog='';child.stderr.on('data',b=>{errorLog=(errorLog+b.toString()).slice(-6000);});
      const base=await new Promise((resolve,reject)=>{
        let buffer='';
        const timer=setTimeout(()=>reject(Error('採点サービスの起動がタイムアウトしました')),15000);
        child.once('error',e=>{clearTimeout(timer);reject(e);});
        child.once('exit',()=>{clearTimeout(timer);reject(Error(errorLog||'採点サービスが終了しました'));});
        child.stdout.on('data',b=>{
          buffer+=b.toString();
          if(!buffer.includes('\n'))return;
          try {const first=JSON.parse(buffer.split('\n')[0]);if(Number.isInteger(first.port)&&first.port>0){clearTimeout(timer);resolve('http://127.0.0.1:'+first.port);}}catch{}
        });
      });
      for(let i=0;i<100;i++){
        if(running.exitCode!==null)throw Error(errorLog||'採点サービスが終了しました');
        try {const res=await fetch(base+'/api/v1/health');const health=await res.json();if(health.instance===instance)return base;}catch{}
        await new Promise(r=>setTimeout(r,100));
      }
      throw Error('採点サービスに接続できません');
    })().catch(e=>{child?.kill();child=null;ready=null;throw e;});
    return ready;
  }
  function command(args) {
    checkRuntime();
    return new Promise((resolve,reject)=>{
      const task=spawn(python,['-m','scoring64.education_project',...args],{cwd:root,env:env(),stdio:['ignore','pipe','pipe']});
      tasks.add(task);task.once('exit',()=>tasks.delete(task));
      let output='',errors='';
      const timer=setTimeout(()=>{task.kill();reject(Error('教材の組版がタイムアウトしました'));},900000);
      task.stdout.on('data',b=>{output+=b.toString();});task.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-12000);});
      task.once('error',e=>{clearTimeout(timer);reject(e);});
      task.once('exit',code=>{clearTimeout(timer);if(code!==0)return reject(Error(errors||output||'教材を生成できませんでした'));try{resolve(JSON.parse(output.trim().split('\n').at(-1)));}catch{reject(Error('教材の生成結果を読み取れませんでした'));}});
    });
  }
  async function showScoring(projectId,createNew=false) {
    const base=await start();
    const url=base+'/?edition=education'+(projectId?'&project='+encodeURIComponent(projectId):'')+(createNew?'&new=1':'');
    if(scoringWindow&&!scoringWindow.isDestroyed()){
      if(projectId||createNew)await scoringWindow.loadURL(url);
      scoringWindow.show();scoringWindow.focus();return;
    }
    scoringWindow=new BrowserWindow({width:1440,height:960,minWidth:800,minHeight:600,title:'TeX64 Education — 採点',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    scoringWindow.webContents.setWindowOpenHandler(({url:target})=>({action:target.startsWith(base+'/api/v1/files/')?'allow':'deny',overrideBrowserWindowOptions:{webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}}}));
    scoringWindow.webContents.on('will-navigate',(e,target)=>{if(!target.startsWith(base+'/'))e.preventDefault();});
    scoringWindow.on('closed',()=>{scoringWindow=null;});
    await scoringWindow.loadURL(url);
  }
  async function guarded(fn) {
    if(busy)return;
    busy=true;getMainWindow()?.setProgressBar(2);
    try {await fn();}catch(e){dialog.showErrorBox('TeX64 Education',e.code==='ERR_ABORTED'?'用紙に未保存の変更があります。採点画面で保存してから開き直してください。':e.message||String(e));}
    finally {busy=false;getMainWindow()?.setProgressBar(-1);}
  }
  async function create() {
    const result=await dialog.showSaveDialog(getMainWindow(),{title:'新しい教材の保存先',defaultPath:path.join(app.getPath('documents'),'Education試験'),buttonLabel:'作成'});
    if(result.canceled||!result.filePath)return;
    const created=await command(['create',result.filePath]);
    await openProject(created.projectPath);
  }
  async function buildAndImport() {
    const project=getRoot();
    if(!project||!fs.existsSync(path.join(project,'exam.structure.json')))throw Error('Educationの教材フォルダを開いてください。「教育」メニューから新しい教材を作成できます。');
    const result=await command(['build',project]);
    const base=await start();
    const form=new FormData();form.append('file',new Blob([fs.readFileSync(result.package)]),'exam.s64exam');
    const response=await fetch(base+'/api/v1/education/import',{method:'POST',headers:{'x-scoring64':'1'},body:form});
    const imported=await response.json();if(!response.ok)throw Error(imported.detail||'教材を取り込めませんでした');
    await showScoring(imported.projectId);
  }
  async function importPdf() {
    const result=await dialog.showOpenDialog(getMainWindow(),{title:'組版した解答用紙PDFを選ぶ',defaultPath:getRoot()||app.getPath('documents'),properties:['openFile'],filters:[{name:'PDF',extensions:['pdf']}]});
    if(result.canceled||!result.filePaths[0])return;
    const file=result.filePaths[0],base=await start();
    const form=new FormData();form.append('file',new Blob([fs.readFileSync(file)]),path.basename(file));
    const response=await fetch(base+'/api/v1/education/pdf',{method:'POST',headers:{'x-scoring64':'1'},body:form});
    const imported=await response.json();if(!response.ok)throw Error(imported.detail||'PDFを取り込めませんでした');
    await showScoring(imported.projectId);
  }
  app.on('before-quit',()=>{child?.kill();for(const task of tasks)task.kill();});
  return {
    menu:()=>({label:'教育',submenu:[{label:'新しい解答用紙・採点を作成…',click:()=>guarded(()=>showScoring(undefined,true))},{label:'組版したPDFから採点を作成…',click:()=>guarded(importPdf)},{type:'separator'},{label:'番号連携付きの教材を作成…',click:()=>guarded(create)},{label:'保存した教材を組版して採点へ送る',click:()=>guarded(buildAndImport)},{type:'separator'},{label:'採点ワークスペースを開く',click:()=>guarded(()=>showScoring())},{label:'原稿へ戻る',click:()=>{getMainWindow()?.show();getMainWindow()?.focus();}}]}),
    startup:()=>guarded(async()=>{if(process.env.TEX64_EDUCATION_PROJECT){await openProject(process.env.TEX64_EDUCATION_PROJECT);}await showScoring();}),
  };
}
module.exports={createEducationService};
