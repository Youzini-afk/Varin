import type { AgentSettingsSnapshot } from '@varin/application-client';
import {
  mergeHarnessWebDomainPolicy,
  parseHarnessWebSearchSettings,
  parseHarnessWebSourcePreferences,
  type HarnessSettings,
  type HarnessWebDomainPolicy,
  } from "@varin/protocol";

export interface HarnessWebBinding {
  generation: string;
  settings: HarnessSettings["web"];
  searchError?: string;
}

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const webFrom = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return record(record(value).harness).web && typeof record(record(value).harness).web === "object"
    && !Array.isArray(record(record(value).harness).web)
    ? record(record(record(value).harness).web)
    : {};
};

const strings = (value: unknown): string[] | undefined => (
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined
);

const domainsFrom = (value: unknown): Partial<HarnessWebDomainPolicy> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const allow = strings(input.allow);
  const block = strings(input.block);
  return allow === undefined && block === undefined
    ? undefined
    : {
        ...(allow === undefined ? {} : { allow }),
        ...(block === undefined ? {} : { block }),
      };
};

/** Material reads consume only the original domain policy, independent of search/render configuration. */
export const resolveHarnessMaterialWebPolicy = (snapshot: AgentSettingsSnapshot): HarnessWebDomainPolicy =>
  mergeHarnessWebDomainPolicy(domainsFrom(webFrom(snapshot.global).domains),
    domainsFrom(snapshot.projectTrusted ? webFrom(snapshot.project).domains : undefined));

/** Freeze credential-free web policy/provider identity for one worker generation. */
export const resolveHarnessWebBinding = (snapshot: AgentSettingsSnapshot): HarnessWebBinding => {
  const user = webFrom(snapshot.global);
  const render = typeof user.render === "boolean" ? user.render : undefined;
  const search = parseHarnessWebSearchSettings(user.search);
  const domains = resolveHarnessMaterialWebPolicy(snapshot);
  const userPreferences = parseHarnessWebSourcePreferences(user.sourcePreferences);
  const projectPreferences = parseHarnessWebSourcePreferences(snapshot.projectTrusted ? webFrom(snapshot.project).sourcePreferences : undefined);
  const sourcePreferences = userPreferences && projectPreferences ? { ...userPreferences, ...projectPreferences } : null;
  const settings: HarnessSettings["web"] = {
    ...(render === undefined ? {} : { render }),
    ...(typeof user.readingAssistance === "boolean" ? { readingAssistance: user.readingAssistance } : {}),
    ...(search ? { search } : {}),
    domains,
    ...(sourcePreferences && Object.keys(sourcePreferences).length ? { sourcePreferences } : {}),
  };
  return {
    generation: `${snapshot.globalRevision}:${snapshot.projectTrusted ? snapshot.projectRevision : "untrusted"}`,
    settings,
    ...(user.search !== undefined && !search ? { searchError: "Invalid web search provider configuration" } : !sourcePreferences ? { searchError: "Invalid web search source preferences" } : {}),
  };
};
