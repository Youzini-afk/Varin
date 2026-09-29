import type { VmExec } from './vm-provider.js';

/** Stateful CLI seam, excluded by the Host production boundary. */
export function libvirtFixture() {
  const domains = new Map<string, { name: string; state: string }>();
  const volumes = new Set<string>();
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const faults = new Map<string, 'before' | 'after'>();
  const exec: VmExec = async (_command, rawArgs, options) => {
    const args = rawArgs.slice(2);
    calls.push({ args, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) });
    const op = args[0]!;
    if (faults.get(op) === 'before') throw new Error(`failed before ${op}`);
    let stdout = '';
    switch (op) {
      case 'version': stdout = 'Running hypervisor: QEMU fixture'; break;
      case 'list': stdout = [...domains].map(([id, domain]) => `${id} ${domain.name}`).join('\n'); break;
      case 'vol-list': stdout = ' Name   Path\n--------------------------\n' + [...volumes].map((name) => ` ${name}   /images/${name}`).join('\n'); break;
      case 'vol-create-as': case 'vol-clone': {
        const name = args[2]!;
        if (volumes.has(name)) return { code: 1, stdout: '', stderr: 'volume already exists' };
        volumes.add(name); break;
      }
      case 'vol-upload': break;
      case 'vol-info': stdout = 'Name: fixture\nType: file\nCapacity: 2147483648\nAllocation: 100000000\n'; break;
      case 'vol-resize': break;
      case 'define': {
        const name = options!.stdin!.match(/<name>(.*?)<\/name>/)![1]!;
        const id = options!.stdin!.match(/<uuid>(.*?)<\/uuid>/)![1]!;
        domains.set(id, { name, state: 'shut off' }); break;
      }
      case 'domstate': {
        const domain = domains.get(args[1]!);
        if (!domain) return { code: 1, stdout: '', stderr: 'domain not found' };
        stdout = domain.state; break;
      }
      case 'start': case 'reboot': domains.get(args[1]!)!.state = 'running'; break;
      case 'shutdown': case 'destroy': domains.get(args[1]!)!.state = 'shut off'; break;
      case 'undefine': domains.delete(args[1]!); break;
      case 'vol-delete': volumes.delete(args.at(-1)!); break;
      default: throw new Error(`Unexpected virsh command ${args.join(' ')}`);
    }
    if (faults.get(op) === 'after') throw new Error(`response lost after ${op}`);
    return { code: 0, stdout, stderr: '' };
  };
  return { domains, volumes, calls, faults, exec };
}
