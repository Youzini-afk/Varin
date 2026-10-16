import { guardProviderReply } from './provider-response.test-helper.js';
import express from 'express';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignatureV4 } from '@smithy/signature-v4';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ModelsService } from '../models/service.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import { createModelAuthority } from './model-authority.js';
import { CredentialBridge } from './credential-bridge.js';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release/varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as {version: string}).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setRuntimeExtraHeaders(null); configureRuntimeUrlResolver({apiBaseUrl:'',realtimeBaseUrl:''}); for(const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
 server.listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address();
 if(!address || typeof address==='string') throw new Error('missing listener');
 cleanups.push(async()=>{server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return `http://127.0.0.1:${address.port}`;
}
const credentials = { accessKeyId: 'FAKEACCESSKEYFORTEST', secretAccessKey: 'fake-secret-for-signature-comparison', sessionToken: 'fake-session-for-signature-comparison' };

async function fixtureModels(directory: string, root: string, endpoint: string) {
 for (const [name, value] of Object.entries({ AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
   AWS_SESSION_TOKEN: credentials.sessionToken, AWS_REGION: 'us-west-2', AWS_PROFILE: '',
   AWS_SHARED_CREDENTIALS_FILE: path.join(root, 'absent-credentials'), AWS_CONFIG_FILE: path.join(root, 'absent-config'), AWS_EC2_METADATA_DISABLED: 'true' })) vi.stubEnv(name, value);
 const models = new ModelsService(directory, { projectTrusted: () => false });
 await models.save({ id: 'bedrock-fixture', type: 'bedrock', name: 'Fixture', enabled: true, baseUrl: endpoint,
   authentication: { kind: 'aws-chain' }, parameters: { region: 'us-west-2' },
   models: [{ id: 'anthropic.fixture-v1', name: 'Fixture', enabled: true, operations: ['chat'] }] }, (await models.read()).revision);
 return models;
}

// Cheap signing-owner check complements the native serializer/credential bridge fixture below.
it.each(['ASCII request', 'Unicode 原文 café 🧪 with "quotes" and \\slashes'])('ModelsService signing preserves exact UTF-8 hash, target and original credential scope: %s', async input => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-bedrock-owner-'));
 cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
 const authority = await fixtureModels(root, root, 'https://bedrock.fixture.test');
 const selected = await createModelAuthority(authority).resolveModel({ providerId: 'bedrock-fixture', modelId: 'anthropic.fixture-v1' });
 cleanups.push(async () => selected.credentialOwner.release());
 const scope = await selected.credentialOwner.scope();
 const body = JSON.stringify({ messages: [{ role: 'user', content: [{ text: input }] }] });
 const payloadSha256 = createHash('sha256').update(body, 'utf8').digest('hex');
 const dispatch = { method: 'POST', endpoint: selected.configuration.endpoint, payloadSha256 };
 const signed = await selected.credentialOwner.resolve(scope, undefined, dispatch);
 expect(signed.headers['x-amz-content-sha256']).toBe(payloadSha256);
 const date = signed.headers['x-amz-date']!;
 const signingDate = new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${date.slice(9,11)}:${date.slice(11,13)}:${date.slice(13,15)}Z`);
 const client = new BedrockRuntimeClient({ region: 'us-west-2', credentials });
 const signer = new SignatureV4({ region: 'us-west-2', service: 'bedrock', credentials, sha256: client.config.sha256 });
 const names = /SignedHeaders=([^,]+)/.exec(signed.headers.authorization!)![1]!.split(';');
 const headers = Object.fromEntries(names.map(name => [name, signed.headers[name]!])); delete headers['x-amz-content-sha256'];
 const url = new URL(dispatch.endpoint);
 const expected = await signer.sign({ method: 'POST', protocol: url.protocol, hostname: url.hostname, path: url.pathname, headers, body }, { signingDate });
 expect(signed.headers.authorization).toBe(expected.headers.authorization);
 await expect(selected.credentialOwner.resolve(scope, undefined, { ...dispatch, endpoint: 'https://changed.fixture.test' })).rejects.toMatchObject({ code: 'credential-request-target-changed' });
 expect(await authority.currentScope('bedrock-fixture')).toEqual(scope);
 vi.stubEnv('AWS_ACCESS_KEY_ID', 'FAKEREPLACEMENTKEY');
 expect(await authority.currentScope('bedrock-fixture')).not.toEqual(scope);
 await expect(selected.credentialOwner.resolve(scope, undefined, dispatch)).rejects.toMatchObject({ code: 'credential-resolution-failed' });
});

it.each(['ASCII request with plain text', 'Unicode 原文 café 🧪 with "quotes" and \\slashes'])('Bedrock signs the exact captured UTF-8 HTTP body with the pinned SDK source and never follows redirects or leaks auth: %s', async(input)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-bedrock-sign-review-'));
 cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
 let redirected=0;
 const redirect=await listen(createServer((_request,response)=>{redirected++;response.writeHead(200).end();}));
 const captured: Array<{body:string;headers:IncomingHttpHeaders;method:string;url:string}>=[];
 const endpoint=await listen(createServer((request,response)=>{const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',guardProviderReply(response, ()=>{
  captured.push({body:Buffer.concat(chunks).toString('utf8'),headers:request.headers,method:request.method!,url:request.url!});
  response.writeHead(307,{location:`${redirect}/capture`}).end();
 }));}));
 const agentDir=path.join(root,'agent');await fs.mkdir(agentDir);
 const authority=await fixtureModels(agentDir, root, endpoint);
 const models=createModelAuthority(authority);
 const selected=await models.resolveModel({providerId:'bedrock-fixture',modelId:'anthropic.fixture-v1'});
 cleanups.push(async () => selected.credentialOwner.release());
 const originalScope=await selected.credentialOwner.scope();
 await expect(selected.credentialOwner.resolve(originalScope,undefined,{method:'POST',endpoint:`${redirect}/capture`,payloadSha256:createHash('sha256').update('{}').digest('hex')})).rejects.toMatchObject({code:'credential-request-target-changed'});
 const signedProbe=await selected.credentialOwner.resolve(originalScope,undefined,{method:'POST',endpoint:selected.configuration.endpoint,payloadSha256:createHash('sha256').update('{"messages":[]}').digest('hex')});
 expect(signedProbe.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
 const privateRequests: Array<Record<string, unknown>>=[];
 const consume=CredentialBridge.prototype.consume;
 vi.spyOn(CredentialBridge.prototype,'consume').mockImplementation(function(this: CredentialBridge, value) {
  if(value && typeof value==='object' && (value as {kind?:string}).kind==='credential-request') privateRequests.push(value as Record<string,unknown>);
  return consume.call(this,value);
 });
 const kernel=createKernelClient({hostId:'bedrock-sign-review',storageRoot:path.join(root,'kernel'),buildVersion,kernelPath,allowCargoDevRunner:false});
 cleanups.push(()=>kernel.close());
 const runtime=new AgentRuntimeClient(kernel);const errors:unknown[]=[];
 const adapter=new ThreadAdapter(runtime,models,async()=>{throw new Error('no source');},(_id,error)=>errors.push(error));
 const app=express();registerCommonRequestMiddleware(app,{express});registerThreadRoutes(app,adapter,(_req,_res,next)=>next());
 const host=await listen(createServer(app));configureRuntimeUrlResolver({apiBaseUrl:host,realtimeBaseUrl:host});
 const api=createThreadsHttpAPI();const identity=await api.create('bedrock-signature');
 const receipt=await api.submit({...identity,key:'unicode-input',expectedHead:null,text:input,model:{providerId:'bedrock-fixture',modelId:'anthropic.fixture-v1'}});
 await expect.poll(async()=>({captured:captured.length,state:(await api.run(receipt.run_id)).state,errors}),{timeout:10_000}).toMatchObject({captured:1});
 await expect.poll(async()=>(await api.run(receipt.run_id)).state,{timeout:10_000}).toBe('failed');
 expect(redirected).toBe(0);expect(errors).toEqual([]);
 const wire=captured[0]!;expect(wire.body).toContain(input.startsWith('Unicode')?'原文':'ASCII');expect(wire.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
 // Resolve the official signer independently of Varin's credential-owner implementation.
 const client=new BedrockRuntimeClient({region:'us-west-2',credentials});
 const signer=new SignatureV4({region:'us-west-2',service:'bedrock',credentials,sha256:client.config.sha256});
 const date=String(wire.headers['x-amz-date']);const signingDate=new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${date.slice(9,11)}:${date.slice(11,13)}:${date.slice(13,15)}Z`);
 expect(wire.headers['x-amz-content-sha256']).toBe(createHash('sha256').update(wire.body,'utf8').digest('hex'));
 expect(privateRequests).toHaveLength(1);
 expect(privateRequests[0]).toMatchObject({runId:receipt.run_id,scope:originalScope,dispatch:{method:wire.method,endpoint:selected.configuration.endpoint,payloadSha256:wire.headers['x-amz-content-sha256']}});
 expect(Object.keys(privateRequests[0]!.dispatch as object).sort()).toEqual(['endpoint','method','payloadSha256']);
 expect(JSON.stringify(privateRequests)).not.toContain(input);
 const signedNames=/SignedHeaders=([^,]+)/.exec(String(wire.headers.authorization))![1]!.split(';');
 const headers=Object.fromEntries(signedNames.map(name=>[name,String(wire.headers[name])]));
 delete headers['x-amz-content-sha256'];
 const url=new URL(selected.configuration.endpoint);
 const expected=await signer.sign({method:wire.method,protocol:url.protocol,hostname:url.hostname,port:Number(url.port),path:wire.url,headers,body:wire.body},{signingDate});
 expect(wire.headers.authorization).toBe(expected.headers.authorization);
 expect(wire.headers['x-amz-security-token']).toBe(credentials.sessionToken);
 const publicState=JSON.stringify({snapshot:await api.snapshot(identity),events:await api.events(0),run:await api.run(receipt.run_id)});
 for(const secret of Object.values(credentials)) expect(publicState).not.toContain(secret);
 expect(await authority.currentScope('bedrock-fixture')).toEqual(originalScope);
 vi.stubEnv('AWS_ACCESS_KEY_ID', 'FAKEREPLACEMENTKEY');
 expect(await authority.currentScope('bedrock-fixture')).not.toEqual(originalScope);
 await expect(selected.credentialOwner.resolve(originalScope,undefined,{method:'POST',endpoint:selected.configuration.endpoint,payloadSha256:createHash('sha256').update(wire.body).digest('hex')})).rejects.toMatchObject({code:'credential-resolution-failed'});
 expect(captured).toHaveLength(1);
},30_000);
