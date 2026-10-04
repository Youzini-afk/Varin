import { knowledgeStoreProcess } from "../store-process.js";
import type { purgeSemanticWorkspaceCache as purge } from "./cache-maintenance-engine.js";

/** The workspace maintenance gate stops writers before handing native cleanup
 * to the same private owner as semantic query/publication. */
export async function purgeSemanticWorkspaceCache(input: Parameters<typeof purge>[0]): Promise<void> {
  const owner = knowledgeStoreProcess("semantic");
  const id = owner.register({ revision: () => {}, notify: () => {} });
  try { await owner.request(id, "semantic", ["purge", input]); }
  finally { await owner.release(id); }
}
