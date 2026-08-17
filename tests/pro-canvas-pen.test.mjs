import assert from "node:assert/strict";
import test from "node:test";
import { penSegmentFor } from "../Resources/web/app/pro-canvas/pen-math.js";

const prev={x:10,y:20},anchor={x:30,y:40},out={x:5,y:-3},handle={x:4,y:6};
test("penSegmentFor covers corner and both handle directions",()=>{
  assert.deepEqual(penSegmentFor(prev,null,anchor,null),{type:"line",to:anchor});
  assert.deepEqual(penSegmentFor(prev,out,anchor,null),{type:"cubic",c1:{x:15,y:17},c2:anchor,to:anchor});
  assert.deepEqual(penSegmentFor(prev,null,anchor,handle),{type:"cubic",c1:prev,c2:{x:26,y:34},to:anchor});
  assert.deepEqual(penSegmentFor(prev,out,anchor,handle),{type:"cubic",c1:{x:15,y:17},c2:{x:26,y:34},to:anchor});
});
