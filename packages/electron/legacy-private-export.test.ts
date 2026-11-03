import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { legacyCredentials,openLegacyPrivateChannel,exportLegacyPrivateState } from './legacy-private-export.js';
import { createLegacyMigrationReader,writeLegacyMigrationRecord,LEGACY_MIGRATION_PROTOCOL as protocol } from '@varin/web/server/lib/platform/legacy-migration-protocol.js';
const writer=(stream:PassThrough)=>(bytes:Uint8Array)=>new Promise<void>((resolve,reject)=>stream.write(bytes,error=>error?reject(error):resolve()));
it('extracts exactly the existing six credential slots without exporting other stored authority',()=>{
 const items=legacyCredentials([['openaiApiKey','synthetic-direct'],['unknown','never'],['config-store',JSON.stringify({state:{sttApiKey:'synthetic-config',clientToken:'never',voiceProvider:'openai'}})]]);
 expect(items).toEqual([{kind:'credential',slot:'openaiApiKey',value:'synthetic-direct'},{kind:'credential',slot:'config-store.state.sttApiKey',value:'synthetic-config'}]);
});
it('uses real framed private pipes, waits for each original acknowledgement and preserves cookie partition fields',async()=>{
 const input=new PassThrough(),output=new PassThrough(),nonce=randomUUID();const read=createLegacyMigrationReader(output);const write=writer(input);
 const opening=openLegacyPrivateChannel(input,writer(output));await writeLegacyMigrationRecord(write,{protocol,version:1,kind:'begin',nonce,lease:{schema:1,pid:1,token:randomUUID(),shell:'tauri'}});const channel=await opening;
 const cookie={name:'session',value:'synthetic-cookie',domain:'example.test',path:'/',secure:true,httpOnly:true,session:false,expires:2000000000,sameSite:'None',priority:'High',sourceScheme:'Secure',sourcePort:443,partitionKey:{topLevelSite:'https://example.test',hasCrossSiteAncestor:true}};
 let finished=false;const exporting=exportLegacyPrivateState({channel,sourceVersion:'1',credentials:[{kind:'credential',slot:'openaiApiKey',value:'synthetic-key'}],cookies:[cookie],origins:(async function*(){yield{origin:'https://example.test',localStorage:[['token','synthetic-site-token']]};})(),uiReceipt:{stage:'staged'}}).then(()=>{finished=true;});
 expect(await read()).toMatchObject({kind:'ready',credentialCount:1,cookieCount:1});const secret=await read();expect(secret).toMatchObject({kind:'credential',sequence:1,value:'synthetic-key'});expect(output.readableLength).toBe(0);expect(finished).toBe(false);
 for(let sequence=1;sequence<=3;sequence++){
  await writeLegacyMigrationRecord(write,{protocol,version:1,nonce,kind:'ack',sequence,status:'imported'});
  const next=await read();if(sequence===1)expect(next.cookie).toEqual(cookie);if(sequence===2)expect(next).toMatchObject({kind:'origin',localStorage:[['token','synthetic-site-token']]});if(sequence===3)expect(next).toMatchObject({kind:'done',records:3});
 }
 expect(finished).toBe(false);await writeLegacyMigrationRecord(write,{protocol,version:1,nonce,kind:'complete',records:3});await exporting;input.destroy();output.destroy();
});
it('fails closed on a cross-session acknowledgement without releasing another secret',async()=>{
 const input=new PassThrough(),output=new PassThrough(),nonce=randomUUID();const read=createLegacyMigrationReader(output),write=writer(input);
 const opening=openLegacyPrivateChannel(input,writer(output));await writeLegacyMigrationRecord(write,{protocol,version:1,kind:'begin',nonce});const channel=await opening;
 const exporting=exportLegacyPrivateState({channel,sourceVersion:'1',credentials:[{kind:'credential',slot:'openaiApiKey',value:'first'},{kind:'credential',slot:'sttApiKey',value:'second'}],cookies:[],origins:(async function*(){})(),uiReceipt:null});
 await read();await read();await writeLegacyMigrationRecord(write,{protocol,version:1,nonce:randomUUID(),kind:'ack',sequence:1,status:'imported'});await expect(exporting).rejects.toThrow('acknowledgement');expect(output.readableLength).toBe(0);input.destroy();output.destroy();
});

it('reports malformed known credential slots as manual recovery instead of copying bad data or stopping other slots',()=>{
 expect(legacyCredentials([['openaiApiKey','valid-synthetic'],['config-store','{malformed']])).toEqual([{kind:'credential',slot:'openaiApiKey',value:'valid-synthetic'},...['openaiApiKey','openaiCompatibleApiKey','sttApiKey'].map(key=>({kind:'credential',slot:`config-store.state.${key}`,sourceStatus:'unavailable'}))]);
});
