export const MINIMUM_PI_VERSION = "0.99.2";
export const MINIMUM_NODE_VERSION = "22.19.0";

export function parseVersion(value: string): string | undefined {
  return value.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
}

export function compareVersions(left: string, right: string): number {
  const [leftCore = "", leftPrerelease] = left.split("-", 2);
  const [rightCore = "", rightPrerelease] = right.split("-", 2);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  if (leftPrerelease === undefined && rightPrerelease !== undefined) return 1;
  if (leftPrerelease !== undefined && rightPrerelease === undefined) return -1;
  if (leftPrerelease === rightPrerelease) return 0;
  const leftIdentifiers = leftPrerelease?.split(".") ?? [];
  const rightIdentifiers = rightPrerelease?.split(".") ?? [];
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index++) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumber = /^\d+$/.test(leftIdentifier) ? Number(leftIdentifier) : undefined;
    const rightNumber = /^\d+$/.test(rightIdentifier) ? Number(rightIdentifier) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftIdentifier.localeCompare(rightIdentifier, "en");
  }
  return 0;
}

export function meetsMinimumPiVersion(version: string | undefined): boolean {
  return version !== undefined && compareVersions(version, MINIMUM_PI_VERSION) >= 0;
}

export function meetsMinimumNodeVersion(version: string | undefined): boolean {
  return version !== undefined && compareVersions(version, MINIMUM_NODE_VERSION) >= 0;
}
