// RFC 8032 section 7.1 public test vector. Not a generated, usable release secret.
// This fixed published seed is used ONLY to make deterministic verifier fixtures.
import { createPrivateKey, createHash, sign } from 'node:crypto';
const key=createPrivateKey({key:Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex'),format:'der',type:'pkcs8'});
const id=Buffer.from('0001020304050607','hex');
export const publicKey=Buffer.from(`untrusted comment: RFC 8032 TEST ONLY\n${Buffer.concat([Buffer.from('Ed'),id,Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a','hex')]).toString('base64')}\n`).toString('base64');
export function signFixture(bytes,version='1.2.3'){
  const signature=sign(null,createHash('blake2b512').update(bytes).digest(),key);
  const comment=`timestamp:0\tfile:fixture\tversion:${version}`;
  const global=sign(null,Buffer.concat([signature,Buffer.from(comment)]),key);
  return Buffer.from(`untrusted comment: TEST ONLY\n${Buffer.concat([Buffer.from('ED'),id,signature]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
}
