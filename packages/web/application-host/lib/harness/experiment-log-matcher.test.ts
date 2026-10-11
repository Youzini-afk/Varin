import assert from 'node:assert/strict';
import { it } from 'vitest';
import { compileLogLiteral, matchLogPage } from './experiment-log-matcher.js';
it('matches exact overlapping UTF-8 bytes across every page cut without treating invalid bytes as replacement text', async () => {
  for (const literal of ['aba','中中','\u0000a']) {
    const matcher = await compileLogLiteral(literal);
    const bytes = Buffer.concat([Buffer.from([0xff]),Buffer.from(literal.repeat(3)),Buffer.from([0xff])]);
    const expected: number[] = []; for(let from=0;;) { const at=bytes.indexOf(matcher.bytes,from);if(at<0)break;expected.push(at);from=at+1; }
    for(let size=1;size<=bytes.length;size++) {
      let offset=0,prefix=0;const matches:number[]=[];
      while(offset<bytes.length) {
        const start=offset;
        for await(const step of matchLogPage(matcher,bytes.subarray(start,start+size),start,prefix)) { offset=step.offset;prefix=step.matchedPrefix;if(step.match)matches.push(step.match.startOffset); }
      }
      assert.deepEqual(matches,expected);
    }
  }
  const replacement=await compileLogLiteral('\ufffd'); const results=[];
  for await(const step of matchLogPage(replacement,Buffer.from([0xff]),0,0)) if(step.match)results.push(step.match);
  assert.deepEqual(results,[]);
});
it('retains the suffix after a committed overlap match and cooperates with cancellation', async () => {
  const matcher=await compileLogLiteral('aba');const first=[];
  for await(const step of matchLogPage(matcher,Buffer.from('ababa'),0,0)) { first.push(step);if(step.match)break; }
  const committed=first.at(-1)!;assert.equal(committed.offset,3);assert.equal(committed.matchedPrefix,1);
  const resumed=[];for await(const step of matchLogPage(matcher,Buffer.from('ba'),3,1))if(step.match)resumed.push(step.match.startOffset);
  assert.deepEqual(resumed,[2]);
  const controller=new AbortController();controller.abort();await assert.rejects(compileLogLiteral('x',controller.signal));
});
