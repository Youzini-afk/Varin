const grants: Readonly<Record<string, readonly string[]>> = {
  file_read: ['storage.read'],
  file_list: ['storage.read'],
  file_search: ['storage.read'],
  file_write: ['storage.read', 'storage.write'],
  file_edit: ['storage.read', 'storage.write'],
  process_spawn: ['storage.read', 'storage.write', 'process'],
};

export function workLocationCapabilities(tool: string): string[] | undefined {
  return Object.hasOwn(grants, tool) ? [...grants[tool]!] : undefined;
}
