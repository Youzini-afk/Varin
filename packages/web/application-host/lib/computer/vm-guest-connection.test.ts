import { expect, it } from 'vitest';
import { vmGuestBootstrapStatus, vmGuestIpv4 } from './vm-guest-connection.js';
import type { VmExec } from './vm-provider.js';

it('finds a guest lease and reads a bootstrap failure through its guest agent', async () => {
  const requests: string[] = [];
  const exec: VmExec = async (_command, args) => {
    requests.push(args[2]!);
    if (args[2] === 'domifaddr') return { code: 0,
      stdout: 'vnet0 52:54:00:00:00:01 ipv4 192.168.122.51/24\n', stderr: '' };
    const payload = JSON.parse(args[4]!) as { execute: string };
    if (payload.execute === 'guest-file-open') return { code: 0, stdout: '{"return":7}', stderr: '' };
    if (payload.execute === 'guest-file-read') return { code: 0,
      stdout: JSON.stringify({ return: { 'buf-b64': Buffer.from('failed: 2\n').toString('base64') } }), stderr: '' };
    return { code: 0, stdout: '{"return":{}}', stderr: '' };
  };
  expect(await vmGuestIpv4(exec, 'qemu:///system', 'uuid')).toBe('192.168.122.51');
  expect(await vmGuestBootstrapStatus(exec, 'qemu:///system', 'uuid')).toBe('failed: 2');
  expect(requests).toContain('qemu-agent-command');
});
