import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeAwsCredentialOwner } from '../src/native-aws-auth.js';

test('AWS owner pins credential source inputs without persisting tokens and changes its opaque identity on source replacement', async t => {
 const directory=await mkdtemp(join(tmpdir(),'varin-aws-source-review-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const env={AWS_ACCESS_KEY_ID:'FAKE_SOURCE_KEY',AWS_SECRET_ACCESS_KEY:'fake-source-secret',AWS_SESSION_TOKEN:'fake-source-session',AWS_REGION:'us-west-2',AWS_SHARED_CREDENTIALS_FILE:join(directory,'credentials'),AWS_CONFIG_FILE:join(directory,'config'),AWS_EC2_METADATA_DISABLED:'true'};
 const owner=new NativeAwsCredentialOwner();const source=await owner.source('fixture',env);
 assert.equal((await owner.source('fixture',env)).identity,source.identity);
 assert.equal(await owner.region(source),'us-west-2');
 const dispatch={method:'POST',endpoint:'https://bedrock-runtime.us-west-2.amazonaws.com/model/fixture/converse-stream',payloadSha256:createHash('sha256').update('{"messages":[{"role":"user","content":[{"text":"原文 café 🧪"}]}]}').digest('hex')};
 const headers=await owner.sign(source,dispatch,{'X-Amz-Content-Sha256':'wrong-upper','x-amz-content-sha256':'wrong-lower','X-AMZ-CONTENT-SHA256':'wrong-all-caps'});
 assert.match(headers.authorization!,/^AWS4-HMAC-SHA256 Credential=FAKE_SOURCE_KEY\//);
 assert.equal(headers['x-amz-security-token'],env.AWS_SESSION_TOKEN);
 assert.equal(headers['x-amz-content-sha256'],dispatch.payloadSha256);
 assert.deepEqual(Object.keys(headers).filter(name=>name.toLowerCase()==='x-amz-content-sha256'),['x-amz-content-sha256']);
 for(const payloadSha256 of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
  await assert.rejects(owner.sign(source,{...dispatch,payloadSha256},{}),{code:'aws-credential-signing-failed'});
 }
 assert.equal((await owner.source('fixture',env)).identity,source.identity);
 const changed=await owner.source('fixture',{...env,AWS_SESSION_TOKEN:'fake-rotated-source-session'});
 assert.notEqual(changed.identity,source.identity);
 assert.notEqual((await new NativeAwsCredentialOwner().source('fixture',env)).identity,source.identity);
 assert.deepEqual(await readdir(directory),[]);
 const beforeFile=(await owner.source('fixture',env)).identity;
 await writeFile(env.AWS_CONFIG_FILE,'[default]\nregion = us-west-2\n');
 assert.notEqual((await owner.source('fixture',env)).identity,beforeFile);
 assert.equal(JSON.stringify({identity:source.identity}).includes('fake-source'),false);
});
