import test from 'node:test';import assert from 'node:assert/strict';
import {typingWarp,typingWeights,typingTarget,TYPING_TIPS} from '../src/art-typing.mjs';
test('typing morph pins wrist and matches shared index-tip target',()=>{
 for(let t=0;t<1;t+=.01){const p={type:1,time:t},target=typingTarget(p),weights=typingWeights(p);assert.ok(Math.abs(Object.values(weights).reduce((a,b)=>a+b)-1)<1e-12);for(const tip of Object.values(TYPING_TIPS)){assert.deepEqual(typingWarp(746,752,tip,target),[746,752]);const q=typingWarp(...tip,tip,target);assert.ok(Math.hypot(q[0]-target[0],q[1]-target[1])<1e-10);}}
});
test('idle rests exactly and phase is continuous',()=>{assert.deepEqual(typingWeights({type:0,time:4}),{rest:1,prep:0,press:0});for(let t=0;t<1;t+=.01){const a=typingTarget({type:1,time:t}),b=typingTarget({type:1,time:t+1e-5});assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<.01);}});
