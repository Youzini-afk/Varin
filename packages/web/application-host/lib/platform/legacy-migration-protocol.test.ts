import {expect,it} from 'vitest';
import {createLegacyMigrationReader,writeLegacyMigrationRecord,LEGACY_MIGRATION_MAX_BYTES} from './legacy-migration-protocol.js';
it('preserves Unicode through arbitrarily fragmented native pipes and obeys each backpressure receipt',async()=>{
 const parts:Uint8Array[]=[];let active=false;
 await writeLegacyMigrationRecord(async bytes=>{expect(active).toBe(false);active=true;await Promise.resolve();parts.push(bytes);active=false;},{kind:'origin',value:'需要原样保留的合成资料'});
 const whole=Buffer.concat(parts);async function* fragmented(){for(const byte of whole)yield Uint8Array.of(byte);}
 expect(await createLegacyMigrationReader(fragmented())()).toEqual({kind:'origin',value:'需要原样保留的合成资料'});
});
it('rejects oversized headers, truncated bodies and invalid UTF-8 rather than changing a stored secret',async()=>{
 async function* one(bytes:Uint8Array){yield bytes;}
 const header=Buffer.alloc(4);header.writeUInt32BE(LEGACY_MIGRATION_MAX_BYTES+1);
 await expect(createLegacyMigrationReader(one(header))()).rejects.toThrow('budget');
 header.writeUInt32BE(4);await expect(createLegacyMigrationReader(one(Buffer.concat([header,Buffer.from('{}')])) )()).rejects.toThrow('ended');
 const bytes=Buffer.from([123,34,118,34,58,34,255,34,125]);header.writeUInt32BE(bytes.length);
 await expect(createLegacyMigrationReader(one(Buffer.concat([header,bytes])))()).rejects.toThrow('malformed');
});
