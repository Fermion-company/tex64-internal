import type { PathSeg, Vec } from "./scene.js";

export const penSegmentFor = (prev:Vec,lastOut:Vec|null,anchor:Vec,handle:Vec|null):PathSeg => {
  if(!lastOut&&!handle)return{type:"line",to:{...anchor}};
  return{type:"cubic",c1:{x:prev.x+(lastOut?.x??0),y:prev.y+(lastOut?.y??0)},c2:{x:anchor.x-(handle?.x??0),y:anchor.y-(handle?.y??0)},to:{...anchor}};
};
