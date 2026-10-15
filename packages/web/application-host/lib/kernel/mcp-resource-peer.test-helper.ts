/** Deterministic receiver for the original MCP stdio integration. Control files schedule actual
 * protocol messages; neither the installed client nor the Host/Catalog owners are substituted. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeResourcePeer(root: string): Promise<{ agentDir: string; peer: string }> {
  const agentDir = join(root, 'agent');
  const peer = join(root, 'resource-peer.mjs');
  await mkdir(agentDir, { recursive: true });
  await writeFile(peer, `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const root=process.argv[2],trace=join(root,'resource-trace.jsonl'),controls=join(root,'resource-controls.jsonl');
const subscriptions=new Set(),pending=new Map();
// Commands schedule this live receiver only. A restarted connection has no remote replay log.
let consumed=existsSync(controls)?readFileSync(controls,'utf8').split('\\n').length-1:0;
const send=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
const traceValue=value=>appendFileSync(trace,JSON.stringify({pid:process.pid,...value})+'\\n');
const update=params=>send({method:'notifications/resources/updated',params});
traceValue({kind:'receiver_started'});
const drain=()=>{
  if(existsSync(controls)){
    const lines=readFileSync(controls,'utf8').split('\\n');lines.pop();
    while(consumed<lines.length){const command=JSON.parse(lines[consumed++]);
      if(command.kind==='update'){update(command.params);traceValue({kind:'emitted',key:command.key});}
      else if(command.kind==='list_changed'){send({method:'notifications/resources/list_changed'});traceValue({kind:'list_changed'});}
      else if(command.kind==='close'){traceValue({kind:'closed'});process.exit(0);}
    }
  }
  if(existsSync(join(root,'allow-delayed-subscribe')))for(const [id,uri]of pending){
    pending.delete(id);subscriptions.add(uri);send({id,result:{_meta:{original:'resource-subscribe',uri}}});
  }
};
setInterval(drain,20).unref();
createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);traceValue({kind:'request',...q});if(q.id===undefined)return;
  let result;
  switch(q.method){
    case'initialize':result={protocolVersion:'2025-11-25',serverInfo:{name:'original-resource-receiver',version:'1'},capabilities:{tools:{},resources:{subscribe:true,listChanged:true}}};break;
    case'ping':result={};break;
    case'tools/list':result={tools:[]};break;
    case'resources/list':result={resources:[{uri:'fixture://watched',name:'watched'},{uri:'fixture://other',name:'other'}],_meta:{original:'resource-page'}};break;
    case'resources/templates/list':result={resourceTemplates:[]};break;
    case'resources/read':result={contents:[{uri:q.params.uri,mimeType:'text/plain',text:'Only an explicitly authorized resource read returns this body.'}],_meta:{original:'explicit-read'}};break;
    case'resources/subscribe':{
      const uri=q.params.uri;
      update({uri,_meta:{original:'before-subscribe-ack'},extra:{nullable:null,opaque:['keep','original']}});
      if(uri==='fixture://delayed'&&!existsSync(join(root,'allow-delayed-subscribe'))){pending.set(q.id,uri);return;}
      subscriptions.add(uri);result={_meta:{original:'resource-subscribe',uri}};break;
    }
    case'resources/unsubscribe':{
      update({uri:q.params.uri,_meta:{original:'after-local-withdrawal'}});
      if(existsSync(join(root,'deny-unsubscribe'))){send({id:q.id,error:{code:-32000,message:'Receiver cleanup was not acknowledged'}});return;}
      subscriptions.delete(q.params.uri);result={_meta:{original:'resource-unsubscribe'}};break;
    }
    default:send({id:q.id,error:{code:-32601,message:'Unsupported method'}});return;
  }
  send({id:q.id,result});
});
`);
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    original: { command: process.execPath, args: [peer, root], exposure: 'direct' },
  } }));
  return { agentDir, peer };
}
