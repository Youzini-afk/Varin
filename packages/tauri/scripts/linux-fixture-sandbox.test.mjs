import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {requireAuthorizedLinuxInstall,fixtureSandboxDestination,fixtureSandboxInstaller,installFixtureSandbox} from './linux-fixture-sandbox.mjs';
const environment={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_TEMP:'/tmp/runner',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2'};
test('Linux privileged fixture requires additional explicit approval, normal uid and hosted run identity',()=>{
  const valid={disposableRunner:true,authorizedLinuxSandboxInstall:true,environment,platform:'linux',uid:1001};
  assert.doesNotThrow(()=>requireAuthorizedLinuxInstall(valid));
  for(const patch of [{authorizedLinuxSandboxInstall:false},{authorizedLinuxSandboxInstall:'true'},{disposableRunner:false},{uid:0},{platform:'win32'},{environment:{...environment,RUNNER_ENVIRONMENT:'self-hosted'}},{environment:{...environment,GITHUB_RUN_ID:'../escape'}}])assert.throws(()=>requireAuthorizedLinuxInstall({...valid,...patch}));
});
test('Fixture destination is fixed to audited version, architecture and numeric run identifiers',()=>{
  assert.equal(fixtureSandboxDestination(environment,'x64'),'/usr/local/libexec/varin-ci/123-2/electron-45.2.1-x64/chrome-sandbox');
  for(const architecture of ['x86','../x64',''])assert.throws(()=>fixtureSandboxDestination(environment,architecture));
  assert.throws(()=>fixtureSandboxDestination({...environment,GITHUB_RUN_ATTEMPT:'2/../3'},'arm64'));
});
test('Unapproved fixture setup fails before any source read or privileged execution',async()=>{
  await assert.rejects(installFixtureSandbox(),/ephemeral/);
});
test('Fixed privileged installer is syntactically valid Python without executing it',{skip:process.platform!=='linux'},()=>{
  execFileSync('python3',['-c','import ast,sys; ast.parse(sys.argv[1])',fixtureSandboxInstaller],{stdio:'pipe'});
});
