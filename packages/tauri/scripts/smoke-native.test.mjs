import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativeSmoke} from './smoke-native.mjs';
test('native smoke requires fresh target-bound complete actual cases, not a successful exit alone',()=>{
 const report={schema:1,product:'varin-desktop-native-smoke',platform:process.platform,architecture:process.arch,nonce:'test',complete:true,cases:[{name:'browser-sandbox',status:'passed',evidence:{rendererObserved:true}}]};
 assert.equal(validateNativeSmoke(report,{nonce:'test',requiredCases:['browser-sandbox']}),report);
 for(const changed of [{...report,nonce:'stale'},{...report,complete:false},{...report,cases:[]},{...report,cases:[{name:'browser-sandbox',status:'not-run'}]},{...report,cases:[...report.cases,...report.cases]}])assert.throws(()=>validateNativeSmoke(changed,{nonce:'test'}));
 assert.throws(()=>validateNativeSmoke(report,{nonce:'test',requiredCases:['shutdown']}),/Missing/);
});
