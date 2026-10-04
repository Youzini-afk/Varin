import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MaterialsCollectionResult } from "@varin/protocol";
import { HarnessRequestError, type HostServicesBridge } from "./host-services-bridge.js";

const MaterialsParams = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("add"),
    Type.Literal("remove"),
    Type.Literal("list"),
    Type.Literal("search"),
    Type.Literal("share"),
  ]),
  collection_id: Type.Optional(Type.String()),
  snapshot_id: Type.Optional(Type.String({ description: "share: a snapshot the caller can read, without a collection." })),
  target_thread_id: Type.Optional(Type.String({ description: "share: a related thread (parent/child/sibling) that may read the material under its own authority." })),
  name: Type.Optional(Type.String()),
  persist: Type.Optional(Type.Boolean({ description: "Keep the collection after this thread settles." })),
  member: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal("snapshot"), Type.Literal("url"), Type.Literal("paper")]),
    snapshot_id: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    paper: Type.Optional(Type.Object({
      provider: Type.String(),
      id: Type.String(),
      doi: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
    })),
    role: Type.Optional(Type.Union([
      Type.Literal("main"),
      Type.Literal("supplement"),
      Type.Literal("code"),
      Type.Literal("data"),
      Type.Literal("other"),
    ])),
    note: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
  })),
  member_id: Type.Optional(Type.String()),
  query: Type.Optional(Type.String({ description: "Keyword query scoped to this collection's member bodies." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Optional caller-selected maximum number of search hits." })),
});

const encode = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

type MaterialsDetails = {
  kind: "materials";
  status: MaterialsCollectionResult["status"];
  action: string;
  collectionId?: string;
  memberCount?: number;
  members?: unknown[];
  collections?: unknown[];
  hits?: unknown[];
  unreadable?: string[];
  sources?: Array<{ url: string; title: string; snapshotId?: string; provider?: string; paperId?: string; relation?: string }>;
};

const formatMember = (member: NonNullable<MaterialsCollectionResult["collection"]>["members"][number]): string => {
  const target = member.kind === "snapshot"
    ? `snapshot:${member.snapshotId}`
    : member.kind === "url"
      ? member.url ?? "?"
      : `paper:${member.paper?.provider}:${member.paper?.id}`;
  const extra = [
    member.role ? `role=${member.role}` : "",
    member.title ? `title=${encode(member.title)}` : "",
  ].filter(Boolean).join(" ");
  return `  ${member.memberId}  ${target}${extra ? `  ${extra}` : ""}`;
};

export function createMaterialsTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "materials",
    label: "Material Collections",
    description: "Create and manage named material collections (snapshots, URLs, paper identities) and keyword-search within one collection. Members are references to fixed snapshots and sources, not copies.",
    promptSnippet: "materials: named sets of snapshots/URLs/papers with scoped keyword search",
    promptGuidelines: [
      "Collections contain references to fixed snapshots and sources. Adding a URL fetches and pins it; search covers only readable member bodies.",
      "share grants a related thread access to a collection or snapshot under its own authority. persist=true retains a collection after the thread settles.",
    ],
    parameters: MaterialsParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      const fail = (status: MaterialsDetails["status"], message: string, isError = status === "failed") => ({
        content: [{ type: "text" as const, text: `materials ${status}: ${message}` }],
        details: { kind: "materials" as const, status, action: params.action },
        isError,
      });
      try {
        const member = params.member === undefined ? undefined : {
          kind: params.member.kind,
          ...(params.member.snapshot_id ? { snapshotId: params.member.snapshot_id } : {}),
          ...(params.member.url ? { url: params.member.url } : {}),
          ...(params.member.paper ? { paper: params.member.paper } : {}),
          ...(params.member.role ? { role: params.member.role } : {}),
          ...(params.member.note ? { note: params.member.note } : {}),
          ...(params.member.title ? { title: params.member.title } : {}),
        };
        const result = await bridge.request("materials.collections", {
          action: params.action,
          ...(params.collection_id ? { collectionId: params.collection_id } : {}),
          ...(params.name ? { name: params.name } : {}),
          ...(params.persist !== undefined ? { persist: params.persist } : {}),
          ...(member ? { member } : {}),
          ...(params.member_id ? { memberId: params.member_id } : {}),
          ...(params.query ? { query: params.query } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.target_thread_id ? { targetThreadId: params.target_thread_id } : {}),
          ...(params.snapshot_id ? { snapshotId: params.snapshot_id } : {}),
        }, signal ? { signal } : undefined) as MaterialsCollectionResult;
        if (result.status !== "ok") {
          return fail(result.status, result.message ?? "no further detail", result.status === "failed");
        }
        if (params.action === "list") {
          const lines = (result.collections ?? []).map((collection) =>
            `  ${collection.collectionId}  ${collection.name ?? "(unnamed)"}  members=${collection.memberCount}${collection.persisted ? "  persisted" : ""}`);
          return {
            content: [{ type: "text", text: lines.length ? `Collections:\n${lines.join("\n")}` : "No material collections." }],
            details: {
              kind: "materials",
              status: result.status,
              action: params.action,
              collections: result.collections ?? [],
            } satisfies MaterialsDetails,
          };
        }
        if (params.action === "search") {
          const hits = result.hits ?? [];
          const lines = hits.map((hit) => `  ${hit.memberId}  snapshot:${hit.snapshotId}  line ${hit.line}: ${encode(hit.excerpt)}`);
          const unreadable = result.unreadable?.length
            ? `\nUnreadable members: ${result.unreadable.join(", ")}`
            : "";
          return {
            content: [{ type: "text", text: `${hits.length} hit(s) in collection${lines.length ? `:\n${lines.join("\n")}` : "."}${unreadable}` }],
            details: {
              kind: "materials",
              status: result.status,
              action: params.action,
              ...(params.collection_id ? { collectionId: params.collection_id } : {}),
              hits,
              ...(result.unreadable ? { unreadable: result.unreadable } : {}),
            } satisfies MaterialsDetails,
          };
        }
        if (params.action === "share") {
          const grant = result.grant;
          if (!grant) return fail("failed", "missing grant in result");
          return {
            content: [{
              type: "text",
              text: `Shared with thread ${grant.toThreadId}: grant ${grant.grantId} (${grant.snapshotIds.length} snapshot(s), ${grant.collectionIds.length} collection(s)). The receiver reads under its own authority.`,
            }],
            details: {
              kind: "materials",
              status: result.status,
              action: params.action,
              members: [{ grantId: grant.grantId, toThreadId: grant.toThreadId }],
            } satisfies MaterialsDetails,
          };
        }
        const collection = result.collection;
        if (!collection) return fail("failed", "missing collection in result");
        const body = collection.members.map(formatMember).join("\n");
        return {
          content: [{
            type: "text",
            text: `Collection ${collection.collectionId}${collection.name ? ` "${encode(collection.name)}"` : ""} (${collection.members.length} member(s)${collection.persisted ? ", persisted" : ""})${body ? `\n${body}` : ""}`,
          }],
          details: {
            kind: "materials",
            status: result.status,
            action: params.action,
            collectionId: collection.collectionId,
            memberCount: collection.members.length,
            members: collection.members.map((memberEntry) => ({
              memberId: memberEntry.memberId,
              kind: memberEntry.kind,
              ...(memberEntry.snapshotId ? { snapshotId: memberEntry.snapshotId } : {}),
              ...(memberEntry.url ? { url: memberEntry.url } : {}),
              ...(memberEntry.paper ? { paper: memberEntry.paper } : {}),
              ...(memberEntry.role ? { role: memberEntry.role } : {}),
            })),
            sources: collection.members.flatMap((memberEntry) => {
              const url = memberEntry.url;
              if (!url) return [];
              return [{
                url,
                title: memberEntry.title ?? memberEntry.paper?.title ?? url,
                ...(memberEntry.snapshotId ? { snapshotId: memberEntry.snapshotId } : {}),
                ...(memberEntry.paper?.provider ? { provider: memberEntry.paper.provider } : {}),
                ...(memberEntry.paper?.id ? { paperId: memberEntry.paper.id } : {}),
                ...(memberEntry.role ? { relation: `collection:${memberEntry.role}` } : {}),
              }];
            }),
          } satisfies MaterialsDetails,
        };
      } catch (error) {
        const unavailable = error instanceof HarnessRequestError && error.code === "unavailable";
        return fail(unavailable ? "unavailable" : "failed", error instanceof Error ? error.message : String(error), !unavailable);
      }
    },
  });
}
