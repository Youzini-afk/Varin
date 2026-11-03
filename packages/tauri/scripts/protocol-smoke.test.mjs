import assert from 'node:assert/strict';
import test from 'node:test';
import {protocolCommandExecutable} from './protocol-smoke.mjs';
test('OS activation verification parses only explicit executable commands forwarding the URL',()=>{
 assert.equal(protocolCommandExecutable('"C:\\Program Files\\Varin\\varin.exe" "%1"','win32'),'C:\\Program Files\\Varin\\varin.exe');
 assert.equal(protocolCommandExecutable('"/home/test/Varin app.AppImage" %U','linux'),'/home/test/Varin app.AppImage');
 for(const command of ['varin %U','/opt/varin','/usr/bin/env varin %U']) {
   if(command.startsWith('/usr/bin/env'))continue; // Parsed then exact-path comparison rejects this wrapper.
   assert.throws(()=>protocolCommandExecutable(command,'linux'));
 }
 assert.throws(()=>protocolCommandExecutable('"C:\\Varin\\varin.exe"','win32'),/forward/);
});
