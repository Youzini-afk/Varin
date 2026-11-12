import type {Response} from 'express';
/** Stop reading the original target stream until the HTTP observer has drained. */
export async function writeTerminalFrame(response:Response,frame:Record<string,unknown>,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();if(response.destroyed)throw new Error('Terminal observer disconnected');
  if(!response.headersSent){response.setHeader('Content-Type','application/x-ndjson');response.setHeader('Cache-Control','no-store');}
  if(response.write(JSON.stringify(frame)+'\n'))return;
  await new Promise<void>((resolve,reject)=>{
    const clear=()=>{response.off('drain',drain);response.off('close',close);signal.removeEventListener('abort',close);};
    const drain=()=>{clear();resolve();},close=()=>{clear();reject(new Error('Terminal observer disconnected before drain'));};
    response.once('drain',drain);response.once('close',close);signal.addEventListener('abort',close,{once:true});
    if(signal.aborted||response.destroyed)close();
  });
}
