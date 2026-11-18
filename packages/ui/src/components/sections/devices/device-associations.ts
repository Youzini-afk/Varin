import React from 'react';
import { runtimeFetch } from '@varin/application-client';

type AssociationGroup = { id: string; name: string | null; members: string[] };
export type DeviceAssociations = { version: 1; groups: AssociationGroup[]; distinct: Array<[string, string]> };
type Snapshot = { associations: DeviceAssociations; revision: string; error?: string };

const path = '/api/devices/associations';

async function readSnapshot(response: Response): Promise<Snapshot> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? String(response.status));
  }
  return response.json() as Promise<Snapshot>;
}

export function useDeviceAssociations(revision: number) {
  const [snapshot, setSnapshot] = React.useState<Snapshot>();
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void runtimeFetch(path, { signal: controller.signal }).then(async response => {
      if (response.status === 403 || response.status === 404) {
        if (!controller.signal.aborted) { setSnapshot(undefined); setError(undefined); }
        return;
      }
      const value = await readSnapshot(response);
      if (!controller.signal.aborted) { setSnapshot(value); setError(value.error); }
    }).catch(error => {
      if (!controller.signal.aborted) setError(String(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [revision]);

  const save = async (associations: DeviceAssociations) => {
    if (!snapshot || saving || loading) return false;
    setSaving(true);
    setError(undefined);
    try {
      const response = await runtimeFetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ associations, revision: snapshot.revision }),
      });
      const value = await readSnapshot(response);
      setSnapshot(value);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { value: snapshot?.associations, busy: saving || loading, error, save };
}

export function attachConnection(associations: DeviceAssociations, service: string, connection: string): DeviceAssociations {
  const group = associations.groups.find(group => group.members.includes(service));
  return {
    ...associations,
    groups: group
      ? associations.groups.map(item => item === group ? { ...item, members: [...item.members, connection] } : item)
      : [...associations.groups, { id: crypto.randomUUID(), name: null, members: [service, connection] }],
    distinct: associations.distinct.filter(pair => !pair.includes(connection) || !pair.includes(service)),
  };
}

export function detachConnection(associations: DeviceAssociations, service: string, connection: string): DeviceAssociations {
  return {
    ...associations,
    groups: associations.groups
      .map(group => group.members.includes(service) ? { ...group, members: group.members.filter(member => member !== connection) } : group)
      .filter(group => group.members.length > 1),
    distinct: [...associations.distinct, [service, connection]],
  };
}
