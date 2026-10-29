import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { useCompanionWindow } from './useCompanionWindow';
import { useCompanionLeisure } from './useCompanionLeisure';
vi.mock('@/lib/desktop', () => ({ isElectronShell: () => false, invokeDesktop: vi.fn() }));
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function environment() {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window',window); vi.stubGlobal('document',window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  Object.defineProperty(document,'hidden',{configurable:true,value:false,writable:true});
  const root=createRoot(document.getElementById('root')!); cleanup=()=>act(()=>root.unmount()); vi.useFakeTimers();
  return root;
}
it('requires actual alpha dwell and never turns pointer cancellation into tap', () => {
  const root=environment();
  const canvas={width:2,height:1,getBoundingClientRect:()=>({x:0,y:0,left:0,top:0,right:100,bottom:100,width:100,height:100}),getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([1,1,1,255,0,0,0,0])})}),setPointerCapture(){},hasPointerCapture(){return false;}} as unknown as HTMLCanvasElement;
  let view: ReturnType<typeof useCompanionWindow>;
  function Harness(){const ref=React.useRef(canvas);view=useCompanionWindow(ref,true);return null;}
  act(()=>root.render(<Harness/>)); act(()=>view!.refreshHitMask());
  const e=(x:number)=>({clientX:x,clientY:10,pointerType:'mouse',pointerId:1,button:0,currentTarget:canvas,preventDefault(){}} as React.PointerEvent<HTMLCanvasElement>);
  act(()=>{view!.handlers.onPointerMove(e(90));vi.advanceTimersByTime(800);}); expect(view!.hoverRevision).toBe(0);
  act(()=>view!.handlers.onPointerMove(e(10))); act(()=>vi.advanceTimersByTime(699)); expect(view!.hoverRevision).toBe(0);
  act(()=>view!.handlers.onPointerLeave()); act(()=>vi.advanceTimersByTime(10)); expect(view!.hoverRevision).toBe(0);
  act(()=>view!.handlers.onPointerMove(e(10))); act(()=>vi.advanceTimersByTime(700)); expect(view!.hoverRevision).toBe(1);
  act(()=>{view!.handlers.onPointerDown(e(10));view!.handlers.onPointerCancel();}); expect(view!.tapRevision).toBe(0);
  act(()=>{view!.handlers.onPointerDown(e(10));view!.handlers.onPointerUp();}); expect(view!.tapRevision).toBe(1);
});
it('requires uninterrupted eligible visible idle, rather than hidden elapsed time', () => {
  const root=environment(); let due=false;
  function Harness({eligible,activity}:{eligible:boolean;activity:number}){due=useCompanionLeisure(eligible,activity).restDue;return null;}
  act(()=>root.render(<Harness eligible activity={0}/>)); act(()=>vi.advanceTimersByTime(299999)); expect(due).toBe(false);
  act(()=>root.render(<Harness eligible={false} activity={0}/>)); act(()=>vi.advanceTimersByTime(300001)); expect(due).toBe(false);
  act(()=>root.render(<Harness eligible activity={1}/>)); act(()=>vi.advanceTimersByTime(300000)); expect(due).toBe(true);
  act(()=>{Object.defineProperty(document,'hidden',{value:true});document.dispatchEvent(new window.Event('visibilitychange'));}); expect(due).toBe(false);
  act(()=>vi.advanceTimersByTime(600000)); expect(due).toBe(false);
});
