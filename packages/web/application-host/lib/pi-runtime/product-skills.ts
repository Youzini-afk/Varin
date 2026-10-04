/**
 * Product skills (Stage S / D-309 S4): a small set of Varin-authored Pi
 * skills seeded into the user-scope resource root (`<agentDir>/skills/`).
 *
 * These are product skills — they teach composition over the live settings
 * catalog and follow-up/experiment tools. They reference stable catalog ids
 * and action entries; current values, model lists, install state, and
 * credentials are always queried at run time, never copied here.
 *
 * Seeding semantics: a skill directory is product-managed only while its
 * SKILL.md still matches the hash this host last wrote (tracked in
 * `.varin-managed`). Once the user edits the file it becomes theirs and is
 * never overwritten. Missing product files are seeded on Host startup.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface ProductSkill {
  /** Directory name under `<agentDir>/skills/` — also the resource id stem. */
  id: string;
  name: string;
  description: string;
  /** SKILL.md body (markdown after frontmatter). */
  body: string;
}

const MANAGED_MARKER = '.varin-managed';

const PRODUCT_SKILLS: readonly ProductSkill[] = [
  {
    id: "varin-research-environment",
    name: "varin-research-environment",
    description: "Varin research environment reference: model-role settings, retrieval components, notifications, and experiment tools. Relevant when configuring or inspecting a research setup.",
    body: `# Research environment

The settings catalog exposes current values, field paths, scope, revisions,
and available actions. \`settings_search\` accepts a query or category;
\`settings_read({id, detail:true})\` expands one entry.

## Configuration entries

- \`harness.models.research\`: investigation, experimental design, fast
  exploration, and high-throughput execution slots.
- \`harness.models.explore\` and \`harness.models.reader\`: source search and
  page-reading model slots.
- \`harness.web.search\` and \`harness.web.domains\`: Web search provider and
  domain policy.
- \`language-support.workspace\` / \`language-support.pack\`: language
  detection status and language-server preparation.
- \`notifications.delivery\`, \`notifications.events\`, and
  \`notifications.push\`: notification preferences and push-service actions.

\`settings_update\` writes the field paths listed by a catalog entry.
\`expectedRevision\` is the owning document revision from \`settings_read\`.
\`appliedAt\` identifies immediate, next-run, restart, or manual application.
Client-owned entries resolve to the caller's connected surface; zero surfaces
is unavailable and multiple surfaces is ambiguous.

## Research tools

\`resources\` reports machine capacity, commitments, observations, and queue
state. \`experiment\` manages durable attempt identities, logs, and artifacts.
\`follow_up\` records a condition and continuation for the current conversation.
These tools appear only when the session's work focus and tool selection
enable them.

Action entries use \`settings_action({id, verb, args})\`; their returned
verbs and state describe the available operation. A pending
action includes \`operation.id\`, queryable with \`verb:"status"\` and
\`operationId\`. Cancellation is available only when that operation exposes it.
`,
  },
  {
    id: "varin-multi-agent-models",
    name: "varin-multi-agent-models",
    description: "Reference for Varin model-role catalog ids, per-field updates, provider readiness, and when role changes apply to delegated runs.",
    body: `# Model roles

Model-role settings are user-owned Pi settings. Their writable scope is
\`global\`; project settings cannot override them.

| Catalog id | Field paths |
| --- | --- |
| \`harness.models.explore\` | \`harness.models.explore\` |
| \`harness.models.execution\` | \`harness.models.quickImplement\`, \`harness.models.hardImplement\`, \`harness.models.frontend\`, \`harness.models.retrievalAgent\` |
| \`harness.models.research\` | \`harness.models.researchInvestigation\`, \`harness.models.researchExperimentalDesign\`, \`harness.models.researchFastExploration\`, \`harness.models.researchHighThroughputExecution\` |
| \`harness.models.assistance\` | \`harness.models.review\`, \`harness.models.check\` |
| \`harness.models.reader\` | \`harness.models.reader\` |
| \`knowledge.model\` | \`harness.models.memoryOrganizer\` |
| \`harness.models.permissionJudge\` | \`harness.models.permissionJudge\` |

Each slot is an object with \`enabled\`, \`providerId\`, and \`modelId\`.
\`enabled:false\` disables the role while retaining its selected model.
\`settings_read({id, detail:true})\` returns its current value, declared fields,
and revision.

Example update shape (provider/model/revision are values obtained from the
current configuration):

\`\`\`json
{
  "id": "harness.models.execution",
  "scope": "global",
  "set": {
    "harness.models.quickImplement": {
      "enabled": true,
      "providerId": "<provider id>",
      "modelId": "<model id>"
    }
  },
  "expectedRevision": "<revision>"
}
\`\`\`

The catalog accepts its listed field paths, not a replacement of the entire
\`harness.models\` object. \`items[]\` supports changes across multiple catalog
entries; same-owner fields commit together.

\`providers.connect\` exposes \`list\` / \`connect\`;
\`providers.auth\` exposes \`status\` / \`login\`;
\`providers.connection-details\` exposes \`read\` / \`disconnect\`.
For status/login/read/disconnect, \`args.providerId\` identifies the provider.
Login accepts \`args.type\` as \`oauth\` or \`api_key\`. \`providers.models\`
controls model-picker favorites and visibility, not model discovery.

A delegated Run keeps its frozen launch configuration. Role-setting changes
apply to later Runs rather than replacing the model of an active Run.
`,
  },
  {
    id: "varin-retrieval-setup",
    name: "varin-retrieval-setup",
    description: "Reference for Varin Web search/domain settings, language-server preparation, semantic-index status, and MCP search-provider configuration.",
    body: `# Retrieval configuration

| Catalog id | Interface |
| --- | --- |
| \`harness.web.search\` | Search-provider settings |
| \`harness.web.domains\` | Allowed/blocked Web domains |
| \`harness.web.render\` | Desktop page-rendering setting |
| \`harness.models.explore\` | Model-assisted source-search slot |
| \`harness.models.reader\` | Page-reading model slot |
| \`harness.semanticIndex\` | Semantic-index UI entry; settings_read reports availability |
| \`language-support.workspace\` | \`settings_action\` with \`verb:"status"\` |
| \`language-support.pack\` | \`settings_action\` with \`verb:"status"\` or \`"prepare"\` |
| \`mcp.configuration\` | \`settings_action\` with \`verb:"read"\` or \`"write"\` |
| \`mcp.runtime\` | \`settings_action\` with \`verb:"status"\` or \`"reconnect"\` |

\`settings_read({id, detail:true})\` supplies the current fields, scope, revision,
and available action verbs. Ordinary fields use \`settings_update\`; action
entries use \`settings_action\`. Despite its catalog id, \`language-support.pack\`
prepares a language server with \`args.languageId\`, for example:

\`settings_action({id:"language-support.pack", verb:"prepare", args:{languageId:"typescript"}})\`

Structure packs are a separate runtime component. The \`runtime.*\` settings
entries manage the Pi runtime lifecycle, not semantic-index settings.

The default Web search route needs no search credential; an explicitly
configured provider uses its own credential contract. Search results are
metadata/snippets, while \`webfetch\` reads and pins source content.
External MCP providers are available according to their loaded configuration
and runtime status.
`,
  },
  {
    id: "varin-remote-experiments",
    name: "varin-remote-experiments",
    description: "Varin execution reference: machine capacity, managed shell targets, durable experiment attempts, and follow-up conditions. Relevant to local or remote experiment setup.",
    body: `# Execution resources and experiments

\`resources\` is a read-only overview of machine capacity, commitments, usage
observations, connection state, and queued attempts. Capacity and measured
usage are separate values; absent usage is unknown.

## Execution interfaces

- \`bash({command, target, cwd})\` can address a managed execution target
  exposed by the Host. \`cwd\` is a directory on that target.
- \`experiment({action:"submit", requestId, command, ...})\` records a spec and
  attempt. \`machineId\` selects a machine supported by the installed backend;
  registering a machine alone does not install an execution backend.
- \`experiment\` actions \`get\`, \`logs\`, \`artifact\`, \`collect\`, \`wait\`,
  and \`cancel\` address an existing \`attemptId\`. The same submit
  \`requestId\` returns its recorded attempt.
- \`follow_up\` can bind an experiment's terminal state or collected artifact
  to a continuation. Cancelling a follow-up leaves the watched job running.
- Ordinary background-shell waits bind the returned \`executionId\`.
  A local process that cannot be reattached after Host restart becomes
  unavailable; shell output matching retains compact match/cursor facts.

## Related settings have different owners

\`remote-instances.client-auth\` reports client pairing/authentication status.
\`remote-instances.direct-hosts\` selects a client's default connected Host.
\`fleet.provider\`, \`fleet.list\`, and \`fleet.actions\` expose agent-delegation
providers and their jobs. These entries do not register execution machines.

Current action verbs and availability come from
\`settings_read({id, detail:true})\`. A pending domain action exposes its
owner's operation id for a later \`settings_action\` status query.
`,
  },
];

const contentHash = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex');

const renderSkillMd = (skill: ProductSkill): string =>
  `---\nname: ${skill.name}\ndescription: "${skill.description.replace(/"/g, "'")}"\n---\n\n${skill.body}`;

export interface ProductSkillSeedResult {
  seeded: string[];
  updated: string[];
  userOwned: string[];
}

/**
 * Seed product skills into `<agentDir>/skills/`. Idempotent: writes only when
 * the target is absent or still matches the hash this host previously wrote.
 */
export const seedProductSkills = (agentDir: string): ProductSkillSeedResult => {
  const skillsRoot = path.join(agentDir, 'skills');
  const result: ProductSkillSeedResult = { seeded: [], updated: [], userOwned: [] };
  for (const skill of PRODUCT_SKILLS) {
    const dir = path.join(skillsRoot, skill.id);
    const file = path.join(dir, 'SKILL.md');
    const marker = path.join(dir, MANAGED_MARKER);
    const content = renderSkillMd(skill);
    const hash = contentHash(content);
    try {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const markerHash = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null;
      if (existing === null) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        fs.writeFileSync(marker, hash, 'utf8');
        result.seeded.push(skill.id);
        continue;
      }
      if (markerHash === contentHash(existing)) {
        // Still product-owned — apply the new revision.
        fs.writeFileSync(file, content, 'utf8');
        fs.writeFileSync(marker, hash, 'utf8');
        if (existing !== content) result.updated.push(skill.id);
        continue;
      }
      // No marker or diverged content — the user owns this directory now.
      result.userOwned.push(skill.id);
    } catch {
      // A read-only or missing agent dir leaves skills unseeded; sessions
      // simply don't see them. Never block host startup on seeding.
    }
  }
  return result;
};

export const listProductSkillIds = (): readonly string[] => PRODUCT_SKILLS.map((s) => s.id);
