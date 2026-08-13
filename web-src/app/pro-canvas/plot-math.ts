import type { Vec } from "./scene.js";

export const PLOT_PALETTE=["#2563eb","#dc2626","#059669","#9333ea","#ea580c","#0891b2"] as const;
export const zoomRange=(min:number,max:number,focusT:number,factor:number):{min:number;max:number}=>{const width=Math.max(1e-6,Math.min(1e9,Math.abs(max-min)*Math.max(Number.MIN_VALUE,factor))),focus=Math.max(0,Math.min(1,focusT)),value=min+(max-min)*focus;return{min:value-width*focus,max:value+width*(1-focus)};};
export const panRange=(min:number,max:number,deltaT:number):{min:number;max:number}=>{const delta=(max-min)*deltaT;return{min:min+delta,max:max+delta};};

type Fn=(...args:number[])=>number;
const functions:Record<string,{n:number;fn:Fn}>={
  sin:{n:1,fn:x=>Math.sin(x*Math.PI/180)},cos:{n:1,fn:x=>Math.cos(x*Math.PI/180)},tan:{n:1,fn:x=>Math.tan(x*Math.PI/180)},
  asin:{n:1,fn:x=>Math.asin(x)*180/Math.PI},acos:{n:1,fn:x=>Math.acos(x)*180/Math.PI},atan:{n:1,fn:x=>Math.atan(x)*180/Math.PI},
  sqrt:{n:1,fn:Math.sqrt},abs:{n:1,fn:Math.abs},exp:{n:1,fn:Math.exp},ln:{n:1,fn:Math.log},log10:{n:1,fn:Math.log10},log2:{n:1,fn:Math.log2},
  floor:{n:1,fn:Math.floor},ceil:{n:1,fn:Math.ceil},round:{n:1,fn:Math.round},deg:{n:1,fn:x=>x*180/Math.PI},rad:{n:1,fn:x=>x*Math.PI/180},
  min:{n:2,fn:Math.min},max:{n:2,fn:Math.max},mod:{n:2,fn:(x,y)=>x%y},
};

export const compileExpr=(src:string):((x:number)=>number)|null=>{let at=0;type Node=(x:number)=>number;const ws=()=>{while(/\s/.test(src[at]||""))at++;},take=(s:string)=>{ws();if(src.slice(at,at+s.length)!==s)return false;at+=s.length;return true;};
  const primary=():Node=>{ws();if(take("(")){const value=expr();if(!take(")"))throw 0;return value;}const number=src.slice(at).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);if(number){at+=number[0].length;const value=Number(number[0]);return()=>value;}const ident=src.slice(at).match(/^[A-Za-z][A-Za-z0-9]*/)?.[0];if(!ident)throw 0;at+=ident.length;if(ident==="x")return x=>x;if(ident==="pi")return()=>Math.PI;if(ident==="e")return()=>Math.E;const entry=functions[ident];if(!entry||!take("("))throw 0;const args:Node[]=[expr()];while(take(","))args.push(expr());if(!take(")")||args.length!==entry.n)throw 0;return x=>entry.fn(...args.map(arg=>arg(x)));};
  const power=():Node=>{const left=primary();if(!take("^"))return left;const right=unary();return x=>Math.pow(left(x),right(x));};
  const unary=():Node=>take("-")?((value=>x=>-value(x))(unary())):power();
  const term=():Node=>{let left=unary();for(;;){if(take("*")){const right=unary(),prev=left;left=x=>prev(x)*right(x);}else if(take("/")){const right=unary(),prev=left;left=x=>prev(x)/right(x);}else return left;}};
  const expr=():Node=>{let left=term();for(;;){if(take("+")){const right=term(),prev=left;left=x=>prev(x)+right(x);}else if(take("-")){const right=term(),prev=left;left=x=>prev(x)-right(x);}else return left;}};
  try{const fn=expr();ws();return at===src.length?fn:null;}catch{return null;}};

export const samplePlot=(fn:(x:number)=>number,min:number,max:number,samples:number):Vec[][]=>{const pieces:Vec[][]=[];let piece:Vec[]=[];const count=Math.max(2,Math.floor(samples));for(let i=0;i<=count;i++){const x=min+(max-min)*i/count,y=fn(x);if(!Number.isFinite(y)||Math.abs(y)>1e6){if(piece.length)pieces.push(piece);piece=[];}else piece.push({x,y});}if(piece.length)pieces.push(piece);return pieces;};
export const niceTicks=(min:number,max:number,target=5):number[]=>{if(!Number.isFinite(min)||!Number.isFinite(max)||max<=min)return[];const raw=(max-min)/Math.max(1,target),power=Math.pow(10,Math.floor(Math.log10(raw))),fraction=raw/power,nice=fraction<=1?1:fraction<=2?2:fraction<=2.5?2.5:fraction<=5?5:10,step=nice*power,out:number[]=[];for(let value=Math.ceil(min/step)*step;value<=max+step*1e-9;value+=step)out.push(Math.abs(value)<step*1e-10?0:Number(value.toPrecision(12)));return out;};
export const autoRange=(ys:number[]):{min:number;max:number}=>{const finite=ys.filter(Number.isFinite);if(!finite.length)return{min:-1,max:1};const min=Math.min(...finite),max=Math.max(...finite);if(min===max)return{min:-1,max:1};const pad=(max-min)*.05;return{min:min-pad,max:max+pad};};
