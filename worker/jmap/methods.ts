import { desc, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { domains, mailboxMembers, mailboxes } from "../db/schema";
import { mailboxAddressSql, mailboxKindOrderSql } from "../db/mailboxes";
import { createId } from "../lib/ids";
import { inboundMessageId } from "../mail/inbound";
import { ComposerAttachmentLimitError } from "../mail/outbound";
import { submitOutgoing } from "../mail/outbound-service";
import { storeFinalizedComposerUpload } from "../mail/uploads";
import { composeSchema } from "../mail/schemas";
import { mailboxStub, type JmapChangeType } from "../mailbox";
import { systemFolderDefinitions, type MailboxState } from "../mailbox/folder-model";
import type { Email } from "../mailbox/schema";
import { loadUploadedBlob, MAX_UPLOAD_BYTES } from "./blobs";
import { emailBoxes, type EmailFilter, type LocalBox } from "./email-query";
import {
  decodeIdPart,
  decodeState,
  encodeIdPart,
  encodeState,
  parseScopedId,
  scopedId,
  type AccountState,
} from "./ids";

export const CORE = "urn:ietf:params:jmap:core";
export const MAIL = "urn:ietf:params:jmap:mail";
export const SUBMISSION = "urn:ietf:params:jmap:submission";

export const LIMITS = {
  maxSizeUpload: MAX_UPLOAD_BYTES,
  maxConcurrentUpload: 1,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 32,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  collationAlgorithms: [] as string[],
};
const DEFAULT_QUERY_LIMIT = 256;
const MAX_QUERY_LIMIT = 1_000;
// Anchors, negative positions, and queryChanges need every match in order.
const FULL_QUERY_CAP = 10_000;
const COUNT_PROPERTIES = ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"];

export class MethodError extends Error {
  constructor(
    readonly type: string,
    description?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(description ?? type);
  }
}

type AccountMailbox = {
  id: string;
  address: string;
  displayName: string;
  canSend: boolean;
};

export type Account = {
  id: string;
  userId: string;
  name: string;
  mailboxes: AccountMailbox[];
};

type Draft = {
  from: { email: string; name: string | null };
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | undefined;
  subject: string;
  bodyText: string;
  bodyHtml: string | undefined;
  inReplyTo: string[];
  references: string[];
  attachments: DraftAttachment[];
};

type DraftAttachment = {
  r2Key: string;
  name: string;
  type: string;
  size: number;
  disposition: "attachment" | "inline";
  cid: string | undefined;
};

export type RequestContext = {
  env: Env;
  requestUrl: string;
  account: Account;
  defer: (task: Promise<unknown>) => void;
  createdIds: Map<string, string>;
  drafts: Map<string, Draft>;
  submittedDraftRefs: Set<string>;
};

type Args = Record<string, unknown>;
type Response = [string, Args];

export async function loadAccount(env: Env, user: { id: string; name: string }): Promise<Account> {
  const rows = await createDb(env.DB)
    .select({
      id: mailboxes.id,
      address: mailboxAddressSql,
      displayName: mailboxes.displayName,
      canSend: mailboxMembers.canSend,
    })
    .from(mailboxMembers)
    .innerJoin(mailboxes, eq(mailboxMembers.mailboxId, mailboxes.id))
    .innerJoin(domains, eq(mailboxes.domainId, domains.id))
    .where(eq(mailboxMembers.userId, user.id))
    .orderBy(mailboxKindOrderSql, desc(mailboxes.isPrimary), mailboxes.displayName);
  return {
    id: encodeIdPart(user.id),
    userId: user.id,
    name: rows[0]?.address ?? user.name,
    mailboxes: rows,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(description: string): never {
  throw new MethodError("invalidArguments", description);
}

function utcDate(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function parseUtcDate(value: unknown, name: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
    invalid(`${name} must be a UTCDate`);
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) invalid(`${name} must be a UTCDate`);
  return time;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function checkAccount(ctx: RequestContext, args: Args) {
  if (args.accountId !== ctx.account.id) throw new MethodError("accountNotFound");
}

function accountMailbox(ctx: RequestContext, mailboxId: string) {
  return ctx.account.mailboxes.find((mailbox) => mailbox.id === mailboxId) ?? null;
}

function optionalIds(args: Args, name = "ids"): string[] | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    invalid(`${name} must be an array of ids`);
  }
  if (value.length > LIMITS.maxObjectsInGet) throw new MethodError("requestTooLarge");
  return value as string[];
}

function selectedProperties(args: Args, allowed: string[], defaults = allowed) {
  const value = args.properties;
  if (value === undefined || value === null) return new Set(defaults);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.includes(item))) {
    invalid("properties contains an unknown property");
  }
  return new Set(["id", ...(value as string[])]);
}

function pick(object: Args, properties: Set<string>) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => properties.has(key)));
}

function groupByMailbox(ctx: RequestContext, ids: string[]) {
  const groups = new Map<string, Array<{ id: string; objectId: string }>>();
  const notFound: string[] = [];
  for (const id of new Set(ids)) {
    const parsed = parseScopedId(id);
    if (!parsed || parsed.part !== undefined || !accountMailbox(ctx, parsed.mailboxId)) {
      notFound.push(id);
      continue;
    }
    const group = groups.get(parsed.mailboxId) ?? [];
    group.push({ id, objectId: parsed.objectId });
    groups.set(parsed.mailboxId, group);
  }
  return { groups, notFound };
}

export async function currentState(ctx: Pick<RequestContext, "env" | "account">): Promise<AccountState> {
  const entries = await Promise.all(ctx.account.mailboxes.map(async (mailbox) => {
    const { seq } = await mailboxStub(ctx.env, mailbox.id).jmapSequence();
    return [mailbox.id, { seq, canSend: mailbox.canSend }] as const;
  }));
  return new Map(entries);
}

function checkIfInState(args: Args, state: AccountState) {
  if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== encodeState(state)) {
    throw new MethodError("stateMismatch");
  }
}

function setCount(args: Args) {
  const count = (isObject(args.create) ? Object.keys(args.create).length : 0)
    + (isObject(args.update) ? Object.keys(args.update).length : 0)
    + (Array.isArray(args.destroy) ? args.destroy.length : 0);
  if (count > LIMITS.maxObjectsInSet) throw new MethodError("requestTooLarge");
}

/**
 * Folds every mailbox's change log since the client's state. The combined
 * state carries one sequence per mailbox, so a page cut by maxChanges can
 * resume each mailbox from where it stopped.
 */
async function collectChanges(ctx: RequestContext, args: Args, type: JmapChangeType) {
  checkAccount(ctx, args);
  const since = decodeState(args.sinceState);
  if (!since) throw new MethodError("cannotCalculateChanges", "sinceState is not recognized");
  const maxChanges = args.maxChanges ?? null;
  if (maxChanges !== null && (!Number.isSafeInteger(maxChanges) || (maxChanges as number) < 1)) {
    invalid("maxChanges must be a positive integer");
  }
  const mailboxIds = ctx.account.mailboxes.map((mailbox) => mailbox.id);
  if (since.size !== mailboxIds.length || mailboxIds.some((id) => !since.has(id))) {
    throw new MethodError("cannotCalculateChanges", "Mailbox membership changed since this state");
  }
  let budget = (maxChanges as number | null) ?? Number.MAX_SAFE_INTEGER;
  const newState: AccountState = new Map();
  const perMailbox: Array<{
    mailbox: AccountMailbox;
    created: string[];
    updated: string[];
    destroyed: string[];
    contentChanged: boolean;
    rightsChanged: boolean;
  }> = [];
  let hasMoreChanges = false;
  for (const mailbox of ctx.account.mailboxes) {
    const previous = since.get(mailbox.id)!;
    const stub = mailboxStub(ctx.env, mailbox.id);
    if (budget <= 0) {
      const { seq } = await stub.jmapSequence();
      newState.set(mailbox.id, { seq: previous.seq, canSend: previous.canSend });
      hasMoreChanges ||= seq > previous.seq;
      continue;
    }
    const result = await stub.jmapChanges(type, previous.seq, budget);
    if (!result) throw new MethodError("cannotCalculateChanges");
    budget -= result.created.length + result.updated.length + result.destroyed.length;
    hasMoreChanges ||= result.hasMoreChanges;
    // A partially read mailbox keeps its old rights flag so the change is
    // still reported once the client catches up.
    const rightsChanged = previous.canSend !== mailbox.canSend && !result.hasMoreChanges;
    newState.set(mailbox.id, {
      seq: result.seq,
      canSend: result.hasMoreChanges ? previous.canSend : mailbox.canSend,
    });
    perMailbox.push({ mailbox, ...result, rightsChanged });
  }
  return {
    oldState: args.sinceState as string,
    newState: encodeState(newState),
    hasMoreChanges,
    perMailbox,
  };
}

function idChanges(
  ctx: RequestContext,
  changes: Awaited<ReturnType<typeof collectChanges>>,
) {
  const mapIds = (mailboxId: string, ids: string[]) => ids.map((id) => scopedId(mailboxId, id));
  return {
    accountId: ctx.account.id,
    oldState: changes.oldState,
    newState: changes.newState,
    hasMoreChanges: changes.hasMoreChanges,
    created: changes.perMailbox.flatMap((item) => mapIds(item.mailbox.id, item.created)),
    updated: changes.perMailbox.flatMap((item) => mapIds(item.mailbox.id, item.updated)),
    destroyed: changes.perMailbox.flatMap((item) => mapIds(item.mailbox.id, item.destroyed)),
  };
}

// ---------------------------------------------------------------------------
// Mailboxes

const SYSTEM_ROLES: Record<string, string> = {
  inbox: "inbox",
  sent: "sent",
  archive: "archive",
  spam: "junk",
  trash: "trash",
};
const MAILBOX_PROPERTIES = [
  "id", "name", "parentId", "role", "sortOrder", "totalEmails", "unreadEmails",
  "totalThreads", "unreadThreads", "myRights", "isSubscribed",
];

type MailboxObject = Args & { id: string; name: string; parentId: string | null; role: string | null; sortOrder: number };

function rights(canSend: boolean, overrides: Partial<Record<string, boolean>>) {
  return {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: false,
    mayCreateChild: false,
    mayRename: false,
    mayDelete: false,
    maySubmit: canSend,
    ...overrides,
  };
}

function boxId(mailboxId: string, box: LocalBox) {
  return scopedId(mailboxId, box.startsWith("f:") ? box.slice(2) : box);
}

/** Resolves a JMAP Mailbox id to its OpenWorkspace mailbox and view. */
function resolveMailboxId(ctx: RequestContext, id: unknown) {
  if (typeof id !== "string") return null;
  if (!id.includes("-")) {
    const mailboxId = decodeIdPart(id);
    return mailboxId && accountMailbox(ctx, mailboxId) ? { mailboxId, box: "top" as const } : null;
  }
  const parsed = parseScopedId(id);
  if (!parsed || parsed.part !== undefined || !accountMailbox(ctx, parsed.mailboxId)) return null;
  const box: LocalBox = parsed.objectId in SYSTEM_ROLES
    ? (parsed.objectId as LocalBox)
    : `f:${parsed.objectId}`;
  return { mailboxId: parsed.mailboxId, box };
}

async function mailboxObjects(ctx: RequestContext, withCounts: boolean, only?: AccountMailbox) {
  const lists = await Promise.all((only ? [only] : ctx.account.mailboxes).map(async (mailbox, index) => {
    const { folders, counts } = await mailboxStub(ctx.env, mailbox.id)
      .jmapMailboxes(ctx.account.userId, withCounts);
    const countsByBox = new Map(counts.map((row) => [row.box, row]));
    const countFields = (box: string) => {
      const row = countsByBox.get(box);
      return {
        totalEmails: Number(row?.total_emails ?? 0),
        unreadEmails: Number(row?.unread_emails ?? 0),
        totalThreads: Number(row?.total_threads ?? 0),
        unreadThreads: Number(row?.unread_threads ?? 0),
      };
    };
    const topId = encodeIdPart(mailbox.id);
    const objects: MailboxObject[] = [
      {
        id: topId,
        name: mailbox.address,
        parentId: null,
        role: null,
        sortOrder: index,
        ...countFields(""),
        myRights: rights(mailbox.canSend, {
          mayAddItems: false,
          mayRemoveItems: false,
          maySetSeen: false,
          mayCreateChild: true,
        }),
        isSubscribed: true,
      },
      ...systemFolderDefinitions.map((folder) => ({
        id: scopedId(mailbox.id, folder.id),
        name: folder.name,
        parentId: topId,
        role: SYSTEM_ROLES[folder.id]!,
        sortOrder: folder.sortOrder,
        ...countFields(folder.id),
        // Sent is derived from message direction and cannot be assigned.
        myRights: rights(mailbox.canSend, folder.id === "sent"
          ? { mayAddItems: false, mayRemoveItems: false }
          : {}),
        isSubscribed: true,
      })),
      ...folders.map((folder) => ({
        id: scopedId(mailbox.id, folder.id),
        name: folder.name,
        parentId: topId,
        role: null,
        sortOrder: folder.sortOrder,
        ...countFields(`f:${folder.id}`),
        myRights: rights(mailbox.canSend, { mayRename: true, mayDelete: true }),
        isSubscribed: true,
      })),
    ];
    return objects;
  }));
  return lists.flat();
}

async function mailboxGet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const ids = optionalIds(args);
  const properties = selectedProperties(args, MAILBOX_PROPERTIES);
  const state = await currentState(ctx);
  const all = await mailboxObjects(ctx, true);
  const byId = new Map(all.map((mailbox) => [mailbox.id, mailbox]));
  const list = (ids ?? all.map((mailbox) => mailbox.id)).flatMap((id) => {
    const mailbox = byId.get(id);
    return mailbox ? [pick(mailbox, properties)] : [];
  });
  return [["Mailbox/get", {
    accountId: ctx.account.id,
    state: encodeState(state),
    list,
    notFound: (ids ?? []).filter((id) => !byId.has(id)),
  }]];
}

async function mailboxChanges(ctx: RequestContext, args: Args): Promise<Response[]> {
  const changes = await collectChanges(ctx, args, "Mailbox");
  const result = idChanges(ctx, changes);
  let structural = result.created.length + result.updated.length + result.destroyed.length > 0;
  const extra: string[] = [];
  for (const item of changes.perMailbox) {
    if (!item.contentChanged && !item.rightsChanged) continue;
    structural ||= item.rightsChanged;
    // Message changes alter counts on the mailbox's views.
    for (const mailbox of await mailboxObjects(ctx, false, item.mailbox)) extra.push(mailbox.id);
  }
  const skip = new Set([...result.created, ...result.updated, ...result.destroyed]);
  result.updated.push(...extra.filter((id) => !skip.has(id)));
  return [["Mailbox/changes", {
    ...result,
    updatedProperties: result.updated.length && !structural ? COUNT_PROPERTIES : null,
  }]];
}

function matchesMailboxFilter(mailbox: MailboxObject, filter: unknown): boolean {
  if (!isObject(filter)) invalid("filter must be an object");
  if ("operator" in filter) {
    const conditions = filter.conditions;
    if (!Array.isArray(conditions)) invalid("conditions must be an array");
    const results = conditions.map((condition) => matchesMailboxFilter(mailbox, condition));
    if (filter.operator === "AND") return results.every(Boolean);
    if (filter.operator === "OR") return results.some(Boolean);
    if (filter.operator === "NOT") return !results.some(Boolean);
    invalid("Unknown filter operator");
  }
  return Object.entries(filter).every(([key, value]) => {
    if (key === "parentId") return mailbox.parentId === value;
    if (key === "role") return mailbox.role === value;
    if (key === "hasAnyRole") return (mailbox.role !== null) === value;
    if (key === "isSubscribed") return value === true;
    if (key === "name") {
      return typeof value === "string"
        && mailbox.name.toLocaleLowerCase("en-US").includes(value.toLocaleLowerCase("en-US"));
    }
    throw new MethodError("unsupportedFilter", `Unsupported Mailbox filter: ${key}`);
  });
}

async function mailboxQuery(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const state = await currentState(ctx);
  let list = await mailboxObjects(ctx, false);
  if (args.filter !== undefined && args.filter !== null) {
    list = list.filter((mailbox) => matchesMailboxFilter(mailbox, args.filter));
  }
  const sort = (args.sort ?? []) as unknown;
  if (!Array.isArray(sort)) invalid("sort must be an array");
  const comparators = sort.map((item) => {
    if (!isObject(item) || (item.property !== "sortOrder" && item.property !== "name")) {
      throw new MethodError("unsupportedSort");
    }
    const sign = item.isAscending === false ? -1 : 1;
    return item.property === "name"
      ? (a: MailboxObject, b: MailboxObject) => sign * a.name.localeCompare(b.name)
      : (a: MailboxObject, b: MailboxObject) => sign * (a.sortOrder - b.sortOrder);
  });
  if (comparators.length) {
    list = list.toSorted((a, b) => comparators.reduce((result, compare) => result || compare(a, b), 0));
  }
  const position = typeof args.position === "number" ? Math.max(0, args.position) : 0;
  const limit = typeof args.limit === "number" ? args.limit : list.length;
  return [["Mailbox/query", {
    accountId: ctx.account.id,
    queryState: encodeState(state),
    canCalculateChanges: false,
    position,
    ids: list.slice(position, position + limit).map((mailbox) => mailbox.id),
    total: list.length,
  }]];
}

async function mailboxSet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  setCount(args);
  const oldState = await currentState(ctx);
  checkIfInState(args, oldState);
  const created: Args = {};
  const notCreated: Args = {};
  const updated: Args = {};
  const notUpdated: Args = {};
  const destroyed: string[] = [];
  const notDestroyed: Args = {};

  for (const [creationId, value] of Object.entries(isObject(args.create) ? args.create : {})) {
    if (!isObject(value)) {
      notCreated[creationId] = { type: "invalidProperties" };
      continue;
    }
    const bad = Object.keys(value).filter((key) => !["name", "parentId", "role", "sortOrder", "isSubscribed"].includes(key));
    const parent = resolveMailboxId(ctx, value.parentId);
    if (parent?.box !== "top") bad.push("parentId");
    if (value.role !== undefined && value.role !== null) bad.push("role");
    if (typeof value.name !== "string") bad.push("name");
    if (bad.length || !parent) {
      notCreated[creationId] = { type: "invalidProperties", properties: bad };
      continue;
    }
    const result = await mailboxStub(ctx.env, parent.mailboxId)
      .createFolder(createId("fld"), value.name as string);
    if (result.status === "ok") {
      const id = scopedId(parent.mailboxId, result.folder.id);
      ctx.createdIds.set(creationId, id);
      const mailbox = accountMailbox(ctx, parent.mailboxId)!;
      created[creationId] = {
        id,
        role: null,
        sortOrder: result.folder.sortOrder,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        myRights: rights(mailbox.canSend, { mayRename: true, mayDelete: true }),
        isSubscribed: true,
      };
    } else if (result.status === "limit") {
      notCreated[creationId] = { type: "overQuota", description: "Mailbox folder limit reached" };
    } else {
      notCreated[creationId] = {
        type: "invalidProperties",
        properties: ["name"],
        description: result.status === "conflict" ? "A folder with this name already exists" : "Folder name is invalid",
      };
    }
  }

  for (const [id, patch] of Object.entries(isObject(args.update) ? args.update : {})) {
    const target = resolveMailboxId(ctx, id);
    if (!target) {
      notUpdated[id] = { type: "notFound" };
      continue;
    }
    if (!isObject(patch)) {
      notUpdated[id] = { type: "invalidPatch" };
      continue;
    }
    const parentId = encodeIdPart(target.mailboxId);
    const bad = Object.entries(patch).flatMap(([key, value]) => {
      if (key === "name") return typeof value === "string" ? [] : [key];
      if (key === "parentId") return value === parentId && target.box !== "top" ? [] : [key];
      if (key === "isSubscribed" || key === "sortOrder") return [];
      return [key];
    });
    if (bad.length) {
      notUpdated[id] = { type: "invalidProperties", properties: bad };
      continue;
    }
    if (typeof patch.name !== "string") {
      updated[id] = null;
      continue;
    }
    if (target.box === "top" || !target.box.startsWith("f:")) {
      notUpdated[id] = { type: "forbidden", description: "System mailboxes cannot be renamed" };
      continue;
    }
    const result = await mailboxStub(ctx.env, target.mailboxId)
      .renameFolder(target.box.slice(2), patch.name);
    if (result.status === "ok") updated[id] = null;
    else if (result.status === "not_found") notUpdated[id] = { type: "notFound" };
    else notUpdated[id] = { type: "invalidProperties", properties: ["name"] };
  }

  const destroyIds = Array.isArray(args.destroy) ? args.destroy : [];
  for (const id of destroyIds) {
    const target = resolveMailboxId(ctx, id);
    if (!target) {
      notDestroyed[String(id)] = { type: "notFound" };
      continue;
    }
    if (target.box === "top" || !target.box.startsWith("f:")) {
      notDestroyed[id as string] = { type: "forbidden", description: "System mailboxes cannot be destroyed" };
      continue;
    }
    const stub = mailboxStub(ctx.env, target.mailboxId);
    if (args.onDestroyRemoveEmails !== true) {
      const { counts } = await stub.jmapMailboxes(ctx.account.userId, true);
      if (counts.some((row) => row.box === target.box && Number(row.total_emails) > 0)) {
        notDestroyed[id as string] = { type: "mailboxHasEmail" };
        continue;
      }
    }
    // Messages in a custom folder stay in the Inbox after the folder is gone.
    const result = await stub.deleteFolder(target.box.slice(2));
    if (result.status === "ok") destroyed.push(id as string);
    else notDestroyed[id as string] = { type: "notFound" };
  }

  return [["Mailbox/set", {
    accountId: ctx.account.id,
    oldState: encodeState(oldState),
    newState: encodeState(await currentState(ctx)),
    created,
    updated,
    destroyed,
    notCreated,
    notUpdated,
    notDestroyed,
  }]];
}

// ---------------------------------------------------------------------------
// Threads

async function threadGet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const ids = optionalIds(args);
  if (!ids) invalid("Thread/get requires ids");
  const state = await currentState(ctx);
  const { groups, notFound } = groupByMailbox(ctx, ids);
  const list: Args[] = [];
  for (const [mailboxId, items] of groups) {
    const rows = await mailboxStub(ctx.env, mailboxId)
      .jmapThreadEmailIds(items.map((item) => item.objectId));
    for (const item of items) {
      const emailIds = rows.filter((row) => row.conversation_id === item.objectId)
        .map((row) => scopedId(mailboxId, row.id));
      if (emailIds.length) list.push({ id: item.id, emailIds });
      else notFound.push(item.id);
    }
  }
  return [["Thread/get", { accountId: ctx.account.id, state: encodeState(state), list, notFound }]];
}

// ---------------------------------------------------------------------------
// Emails

const EMAIL_PROPERTIES = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt",
  "messageId", "inReplyTo", "references", "sender", "from", "to", "cc", "bcc",
  "replyTo", "subject", "sentAt", "hasAttachment", "preview", "bodyValues",
  "textBody", "htmlBody", "attachments", "bodyStructure",
];
const DEFAULT_EMAIL_PROPERTIES = EMAIL_PROPERTIES.filter((name) => name !== "bodyStructure");
const BODY_PROPERTIES = [
  "partId", "blobId", "size", "name", "type", "charset", "disposition", "cid",
  "language", "location", "subParts",
];
const DEFAULT_BODY_PROPERTIES = BODY_PROPERTIES.filter((name) => name !== "subParts");

type EmailRow = {
  email: Email;
  mailboxState: MailboxState;
  folderId: string | null;
  hasIncoming: boolean;
  readAt: Date | null;
};

function messageIdValues(values: string[]) {
  const ids = values.map((value) => value.replace(/^<|>$/gu, "")).filter(Boolean);
  return ids.length ? ids : null;
}

function addresses(values: Array<{ address: string; name: string | null }>) {
  return values.length ? values.map((value) => ({ name: value.name, email: value.address })) : null;
}

function emailText(email: Email) {
  return [email.bodyText, email.quotedText].filter(Boolean).join("\n\n");
}

function truncateUtf8(value: string, maxBytes: number) {
  if (!maxBytes || byteLength(value) <= maxBytes) return { value, isTruncated: false };
  let result = "";
  let size = 0;
  for (const character of value) {
    size += byteLength(character);
    if (size > maxBytes) break;
    result += character;
  }
  return { value: result, isTruncated: true };
}

function emailMailboxIds(mailboxId: string, row: EmailRow) {
  return Object.fromEntries(emailBoxes({
    direction: row.email.direction,
    mailboxState: row.mailboxState,
    folderId: row.folderId,
    hasIncoming: row.hasIncoming,
  }).map((box) => [boxId(mailboxId, box), true]));
}

function emailKeywords(row: EmailRow) {
  // Outgoing messages are never unread in OpenWorkspace.
  return row.email.direction === "outgoing" || row.readAt ? { $seen: true } : {};
}

async function emailObject(
  ctx: RequestContext,
  mailboxId: string,
  row: EmailRow,
  options: {
    properties: Set<string>;
    bodyProperties: Set<string>;
    fetchText: boolean;
    fetchHtml: boolean;
    maxBodyValueBytes: number;
  },
) {
  const { email } = row;
  const text = emailText(email);
  const needsBodies = ["textBody", "htmlBody", "bodyStructure", "bodyValues"]
    .some((name) => options.properties.has(name));
  const htmlObject = needsBodies && email.bodyHtmlR2Key
    ? await ctx.env.MAIL_STORAGE.get(email.bodyHtmlR2Key)
    : null;
  const html = htmlObject ? await htmlObject.text() : null;
  const part = (fields: Args) => pick({
    partId: null,
    blobId: null,
    size: 0,
    name: null,
    type: "application/octet-stream",
    charset: null,
    disposition: null,
    cid: null,
    language: null,
    location: null,
    ...fields,
  }, options.bodyProperties);
  const textPart = part({
    partId: "1",
    blobId: scopedId(mailboxId, email.id, "_text"),
    size: byteLength(text),
    type: "text/plain",
    charset: "utf-8",
  });
  const htmlPart = html === null ? null : part({
    partId: "2",
    blobId: scopedId(mailboxId, email.id, "_html"),
    size: byteLength(html),
    type: "text/html",
    charset: "utf-8",
  });
  const attachmentParts = email.attachmentsJson.map((file, index) => part({
    partId: `a${index}`,
    blobId: scopedId(mailboxId, email.id, file.id),
    size: file.size,
    name: file.filename,
    type: file.contentType,
    disposition: file.disposition,
    cid: file.contentId,
  }));
  const bodyValues: Args = {};
  if (options.fetchText) bodyValues["1"] = { isEncodingProblem: false, ...truncateUtf8(text, options.maxBodyValueBytes) };
  if (options.fetchHtml && html !== null) {
    bodyValues["2"] = { isEncodingProblem: false, ...truncateUtf8(html, options.maxBodyValueBytes) };
  }
  const multipart = (type: string, subParts: Args[]) => part({ type, subParts });
  const alternative = htmlPart ? multipart("multipart/alternative", [textPart, htmlPart]) : textPart;
  const object = {
    id: scopedId(mailboxId, email.id),
    blobId: scopedId(mailboxId, email.id),
    threadId: scopedId(mailboxId, email.conversationId),
    mailboxIds: emailMailboxIds(mailboxId, row),
    keywords: emailKeywords(row),
    // ponytail: estimated from stored parts; exact raw MIME size needs an R2 head per message.
    size: byteLength(text) + email.attachmentsJson.reduce((sum, file) => sum + file.size, 0),
    receivedAt: utcDate(email.timelineAt),
    messageId: messageIdValues(email.messageIdHeader ? [email.messageIdHeader] : []),
    inReplyTo: messageIdValues(email.inReplyToJson),
    references: messageIdValues(email.referencesJson),
    sender: null,
    from: addresses(email.fromJson),
    to: addresses(email.toJson),
    cc: addresses(email.ccJson),
    bcc: addresses(email.bccJson),
    replyTo: addresses(email.replyToJson),
    subject: email.subject,
    sentAt: utcDate(email.timelineAt),
    hasAttachment: email.attachmentsJson.some((file) => file.disposition === "attachment"),
    preview: email.preview,
    bodyValues,
    textBody: [textPart],
    htmlBody: [htmlPart ?? textPart],
    attachments: attachmentParts,
    bodyStructure: attachmentParts.length
      ? multipart("multipart/mixed", [alternative, ...attachmentParts])
      : alternative,
  };
  return pick(object, options.properties);
}

async function loadEmailRows(ctx: RequestContext, mailboxId: string, objectIds: string[]) {
  return await mailboxStub(ctx.env, mailboxId)
    .jmapGetEmails(ctx.account.userId, objectIds) as EmailRow[];
}

async function emailGet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const ids = optionalIds(args);
  if (!ids) invalid("Email/get requires ids");
  const properties = selectedProperties(args, EMAIL_PROPERTIES, DEFAULT_EMAIL_PROPERTIES);
  const bodyPropertiesValue = args.bodyProperties;
  if (
    bodyPropertiesValue !== undefined && bodyPropertiesValue !== null
    && (!Array.isArray(bodyPropertiesValue) || bodyPropertiesValue.some((item) => !BODY_PROPERTIES.includes(item)))
  ) {
    invalid("bodyProperties contains an unknown property");
  }
  const bodyProperties = new Set<string>([
    ...((bodyPropertiesValue as string[] | undefined | null) ?? DEFAULT_BODY_PROPERTIES),
    "subParts",
  ]);
  const fetchAll = args.fetchAllBodyValues === true;
  const options = {
    properties,
    bodyProperties,
    fetchText: properties.has("bodyValues") && (fetchAll || args.fetchTextBodyValues === true),
    fetchHtml: properties.has("bodyValues") && (fetchAll || args.fetchHTMLBodyValues === true),
    maxBodyValueBytes: typeof args.maxBodyValueBytes === "number" ? args.maxBodyValueBytes : 0,
  };
  const state = await currentState(ctx);
  const { groups, notFound } = groupByMailbox(ctx, ids);
  const list: Args[] = [];
  for (const [mailboxId, items] of groups) {
    const rows = await loadEmailRows(ctx, mailboxId, items.map((item) => item.objectId));
    const byId = new Map(rows.map((row) => [row.email.id, row]));
    for (const item of items) {
      const row = byId.get(item.objectId);
      if (row) list.push(await emailObject(ctx, mailboxId, row, options));
      else notFound.push(item.id);
    }
  }
  return [["Email/get", { accountId: ctx.account.id, state: encodeState(state), list, notFound }]];
}

// --- Email/query ----------------------------------------------------------

type FilterPlan = { forMailbox: (mailboxId: string) => EmailFilter; onlyMailbox: string | null };

const UNSUPPORTED_EMAIL_FILTERS = new Set([
  "minSize", "maxSize", "allInThreadHaveKeyword", "someInThreadHaveKeyword",
  "noneInThreadHaveKeyword", "header",
]);

function planEmailFilter(ctx: RequestContext, filter: unknown): FilterPlan {
  if (filter === undefined || filter === null) {
    return { forMailbox: () => ({ operator: "AND", conditions: [] }), onlyMailbox: null };
  }
  if (!isObject(filter)) invalid("filter must be an object");
  if ("operator" in filter) {
    if (!["AND", "OR", "NOT"].includes(filter.operator as string) || !Array.isArray(filter.conditions)) {
      invalid("Invalid filter operator");
    }
    const children = (filter.conditions as unknown[]).map((item) => planEmailFilter(ctx, item));
    const operator = filter.operator as "AND" | "OR" | "NOT";
    return {
      forMailbox: (mailboxId) => ({
        operator,
        conditions: children.map((child) => child.forMailbox(mailboxId)),
      }),
      onlyMailbox: operator === "AND"
        ? children.find((child) => child.onlyMailbox)?.onlyMailbox ?? null
        : null,
    };
  }
  const builders: Array<(mailboxId: string) => EmailFilter> = [];
  let onlyMailbox: string | null = null;
  const localBox = (id: unknown, mailboxId: string): LocalBox => {
    const resolved = resolveMailboxId(ctx, id);
    return resolved && resolved.mailboxId === mailboxId && resolved.box !== "top" ? resolved.box : "none";
  };
  for (const [key, value] of Object.entries(filter)) {
    if (key === "inMailbox") {
      if (typeof value !== "string") invalid("inMailbox must be an id");
      onlyMailbox = resolveMailboxId(ctx, value)?.mailboxId ?? "";
      builders.push((mailboxId) => ({ inMailbox: localBox(value, mailboxId) }));
    } else if (key === "inMailboxOtherThan") {
      if (!Array.isArray(value)) invalid("inMailboxOtherThan must be an array");
      builders.push((mailboxId) => ({
        inMailboxOtherThan: value.map((id) => localBox(id, mailboxId)),
      }));
    } else if (key === "before" || key === "after") {
      const time = parseUtcDate(value, key);
      builders.push(() => (key === "before" ? { before: time } : { after: time }));
    } else if (key === "hasKeyword" || key === "notKeyword") {
      if (typeof value !== "string") invalid(`${key} must be a keyword`);
      const wanted = key === "hasKeyword";
      // Only $seen is stored; every other keyword is never set.
      builders.push(() => value.toLowerCase() === "$seen"
        ? { seen: wanted }
        : wanted ? { none: true } : { operator: "AND", conditions: [] });
    } else if (key === "hasAttachment") {
      if (typeof value !== "boolean") invalid("hasAttachment must be a boolean");
      builders.push(() => ({ hasAttachment: value }));
    } else if (["text", "body", "from", "to", "cc", "bcc", "subject"].includes(key)) {
      if (typeof value !== "string") invalid(`${key} must be a string`);
      builders.push(() => ({ [key]: value }) as EmailFilter);
    } else if (UNSUPPORTED_EMAIL_FILTERS.has(key)) {
      throw new MethodError("unsupportedFilter", `Filtering by ${key} is not supported`);
    } else {
      throw new MethodError("unsupportedFilter", `Unknown filter property ${key}`);
    }
  }
  return {
    forMailbox: (mailboxId) => ({ operator: "AND", conditions: builders.map((build) => build(mailboxId)) }),
    onlyMailbox,
  };
}

function emailSortAscending(sort: unknown) {
  if (sort === undefined || sort === null) return false;
  if (!Array.isArray(sort)) invalid("sort must be an array");
  if (sort.length === 0) return false;
  const [first] = sort;
  if (
    sort.length !== 1 || !isObject(first)
    || (first.property !== "receivedAt" && first.property !== "sentAt")
  ) {
    throw new MethodError("unsupportedSort", "Only receivedAt sorting is supported");
  }
  return first.isAscending === true;
}

async function runEmailQuery(ctx: RequestContext, args: Args, limit: number, calculateTotal: boolean) {
  const plan = planEmailFilter(ctx, args.filter);
  const ascending = emailSortAscending(args.sort);
  const collapseThreads = args.collapseThreads === true;
  const targets = plan.onlyMailbox !== null
    ? ctx.account.mailboxes.filter((mailbox) => mailbox.id === plan.onlyMailbox)
    : ctx.account.mailboxes;
  const results = await Promise.all(targets.map(async (mailbox) => {
    const result = await mailboxStub(ctx.env, mailbox.id).jmapQueryEmails({
      userId: ctx.account.userId,
      filter: plan.forMailbox(mailbox.id),
      ascending,
      collapseThreads,
      limit,
      calculateTotal,
    });
    return {
      truncated: result.rows.length >= limit,
      total: result.total,
      rows: result.rows.map((row) => ({ id: scopedId(mailbox.id, row.id), time: row.timeline_at })),
    };
  }));
  const sign = ascending ? 1 : -1;
  const rows = results.flatMap((result) => result.rows).sort((a, b) =>
    sign * (a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  );
  return {
    ids: rows.map((row) => row.id),
    total: results.reduce((sum, result) => sum + Number(result.total ?? 0), 0),
    truncated: results.some((result) => result.truncated),
  };
}

async function emailQuery(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const position = args.position ?? 0;
  if (!Number.isSafeInteger(position)) invalid("position must be an integer");
  const requestedLimit = args.limit ?? null;
  if (requestedLimit !== null && (!Number.isSafeInteger(requestedLimit) || (requestedLimit as number) < 0)) {
    invalid("limit must be a non-negative integer");
  }
  const limit = Math.min((requestedLimit as number | null) ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const anchor = args.anchor ?? null;
  if (anchor !== null && typeof anchor !== "string") invalid("anchor must be an id");
  const needsFullList = anchor !== null || (position as number) < 0;
  const state = await currentState(ctx);
  const result = await runEmailQuery(
    ctx,
    args,
    needsFullList ? FULL_QUERY_CAP : (position as number) + limit,
    args.calculateTotal === true || needsFullList,
  );
  let start = position as number;
  if (anchor !== null) {
    const index = result.ids.indexOf(anchor);
    if (index < 0) throw new MethodError("anchorNotFound");
    const offset = Number.isSafeInteger(args.anchorOffset) ? (args.anchorOffset as number) : 0;
    start = Math.max(0, index + offset);
  } else if (start < 0) {
    start = Math.max(0, result.total + start);
  }
  return [["Email/query", {
    accountId: ctx.account.id,
    queryState: encodeState(state),
    canCalculateChanges: true,
    position: start,
    ids: result.ids.slice(start, start + limit),
    ...(args.calculateTotal === true ? { total: result.total } : {}),
    ...(requestedLimit !== limit ? { limit } : {}),
  }]];
}

/**
 * Every Email touched since the old state is reported as removed, and the
 * touched ones still matching are re-added at their current index. That is
 * the "extra removed ids" allowance in RFC 8620 section 5.6.
 */
async function emailQueryChanges(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const changes = await collectChanges(ctx, { ...args, sinceState: args.sinceQueryState, maxChanges: null }, "Email");
  const emailChanges = idChanges(ctx, changes);
  const touched = new Set([...emailChanges.created, ...emailChanges.updated, ...emailChanges.destroyed]);
  if (args.collapseThreads === true) {
    // A new or removed message can change which message represents a thread.
    const threads = await collectChanges(ctx, { ...args, sinceState: args.sinceQueryState, maxChanges: null }, "Thread");
    for (const item of threads.perMailbox) {
      const rows = await mailboxStub(ctx.env, item.mailbox.id)
        .jmapThreadEmailIds([...item.created, ...item.updated]);
      for (const row of rows) touched.add(scopedId(item.mailbox.id, row.id));
    }
  }
  const maxChanges = args.maxChanges;
  if (Number.isSafeInteger(maxChanges) && touched.size > (maxChanges as number)) {
    throw new MethodError("tooManyChanges");
  }
  const result = await runEmailQuery(ctx, args, FULL_QUERY_CAP, true);
  if (result.truncated) throw new MethodError("cannotCalculateChanges", "Query result is too large");
  const added = result.ids.flatMap((id, index) => (touched.has(id) ? [{ id, index }] : []));
  return [["Email/queryChanges", {
    accountId: ctx.account.id,
    oldQueryState: args.sinceQueryState,
    newQueryState: changes.newState,
    ...(args.calculateTotal === true ? { total: result.total } : {}),
    removed: [...touched],
    added,
  }]];
}

// --- Email/set ------------------------------------------------------------

function jsonPointerToken(value: string) {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function placementSource(row: EmailRow) {
  if (row.mailboxState !== "active") return row.mailboxState;
  return row.hasIncoming ? "inbox" : "sent";
}

/**
 * OpenWorkspace stores one location per conversation. Returns the
 * conversation update that yields exactly the requested mailboxIds (Sent is
 * implied by direction, Inbox by a custom folder), or null if impossible.
 */
function placementFor(row: EmailRow, desired: LocalBox[]) {
  if (desired.includes("none")) return null;
  const locations = desired.filter((box) => box !== "sent");
  const special = locations.filter((box) => box === "archive" || box === "spam" || box === "trash");
  const custom = locations.filter((box) => box.startsWith("f:"));
  if (special.length > 1 || custom.length > 1) return null;
  const target = special.length
    ? { mailboxState: special[0] as "archive" | "spam" | "trash", folderId: row.folderId }
    : { mailboxState: "active" as const, folderId: custom[0]?.slice(2) ?? null };
  const result = emailBoxes({ ...row, direction: row.email.direction, ...target });
  const expected = new Set(desired);
  if (custom.length) expected.add("inbox");
  if (row.email.direction === "outgoing" && target.mailboxState !== "trash") expected.add("sent");
  if (result.length !== expected.size || result.some((box) => !expected.has(box))) return null;
  return target;
}

async function moveConversation(
  ctx: RequestContext,
  mailboxId: string,
  row: EmailRow,
  target: { mailboxState: "active" | "archive" | "spam" | "trash"; folderId: string | null },
) {
  if (target.mailboxState === row.mailboxState && (target.mailboxState !== "active" || target.folderId === row.folderId)) {
    return true;
  }
  const update = target.mailboxState !== "active"
    ? { mailboxState: target.mailboxState }
    : target.folderId
      ? { folderId: target.folderId }
      : { mailboxState: "active" as const, folderId: null };
  const count = await mailboxStub(ctx.env, mailboxId)
    .bulkUpdateConversations([row.email.conversationId], placementSource(row), update);
  return count === 1;
}

async function updateEmail(ctx: RequestContext, id: string, patch: unknown): Promise<Args | null> {
  const parsed = parseScopedId(id);
  if (!parsed || parsed.part !== undefined || !accountMailbox(ctx, parsed.mailboxId)) {
    return { type: "notFound" };
  }
  if (!isObject(patch)) return { type: "invalidPatch" };
  let seen: boolean | null = null;
  let mailboxIds: Record<string, unknown> | null = null;
  const mailboxPatches: Array<[string, unknown]> = [];
  const bad: string[] = [];
  for (const [path, value] of Object.entries(patch)) {
    if (path === "keywords") {
      if (!isObject(value)) bad.push(path);
      else seen = value.$seen === true;
    } else if (path.startsWith("keywords/")) {
      if (value !== true && value !== null) bad.push(path);
      // Keywords other than $seen are not stored and are ignored.
      else if (jsonPointerToken(path.slice(9)) === "$seen") seen = value === true;
    } else if (path === "mailboxIds") {
      if (!isObject(value)) bad.push(path);
      else mailboxIds = value;
    } else if (path.startsWith("mailboxIds/")) {
      if (value !== true && value !== null) bad.push(path);
      else mailboxPatches.push([jsonPointerToken(path.slice(11)), value]);
    } else {
      bad.push(path);
    }
  }
  if (bad.length) return { type: "invalidProperties", properties: bad };
  const [row] = await loadEmailRows(ctx, parsed.mailboxId, [parsed.objectId]);
  if (!row) return { type: "notFound" };

  if (mailboxIds || mailboxPatches.length) {
    const desired = new Set(mailboxIds
      ? Object.entries(mailboxIds).flatMap(([key, value]) => (value === true ? [key] : []))
      : Object.keys(emailMailboxIds(parsed.mailboxId, row)));
    for (const [key, value] of mailboxPatches) {
      if (value === true) desired.add(key);
      else desired.delete(key);
    }
    const boxes = [...desired].map((key) => {
      const resolved = resolveMailboxId(ctx, key);
      return resolved && resolved.mailboxId === parsed.mailboxId && resolved.box !== "top"
        ? resolved.box
        : "none";
    });
    const target = placementFor(row, boxes);
    if (!target) {
      return {
        type: "invalidProperties",
        properties: ["mailboxIds"],
        description: "This mailbox combination cannot be represented; folders apply to whole conversations",
      };
    }
    if (!await moveConversation(ctx, parsed.mailboxId, row, target)) {
      return { type: "invalidProperties", properties: ["mailboxIds"], description: "Target mailbox not found" };
    }
  }
  if (seen !== null && row.email.direction === "incoming") {
    await mailboxStub(ctx.env, parsed.mailboxId)
      .setMessageRead(ctx.account.userId, parsed.objectId, seen);
  }
  return null;
}

const DRAFT_PROPERTIES = new Set([
  "from", "to", "cc", "bcc", "replyTo", "subject", "textBody", "htmlBody",
  "bodyValues", "bodyStructure", "attachments", "inReplyTo", "references",
  "keywords", "mailboxIds", "messageId", "sentAt", "receivedAt", "sender",
]);

function draftAddresses(value: unknown, property: string, bad: string[]) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => !isObject(item) || typeof item.email !== "string")) {
    bad.push(property);
    return [];
  }
  return value as Array<{ email: string; name?: string | null }>;
}

function draftBody(value: Args, bad: string[]) {
  const values = isObject(value.bodyValues) ? value.bodyValues : {};
  let text: string | undefined;
  let html: string | undefined;
  // Parts that reference an uploaded blob are attachments.
  const attachmentParts: Args[] = [];
  const take = (part: unknown, property: string) => {
    const partValue = isObject(part) && typeof part.partId === "string" ? values[part.partId] : undefined;
    if (isObject(part) && typeof part.type === "string" && part.type.startsWith("multipart/") && Array.isArray(part.subParts)) {
      for (const child of part.subParts) take(child, property);
      return;
    }
    if (isObject(part) && part.blobId !== undefined && part.blobId !== null) {
      if (property === "bodyStructure") attachmentParts.push(part);
      else bad.push(property);
      return;
    }
    if (!isObject(partValue) || typeof partValue.value !== "string") {
      bad.push(property);
      return;
    }
    const type = isObject(part) && typeof part.type === "string" ? part.type.toLowerCase() : "text/plain";
    if (type === "text/html") html = partValue.value;
    else if (type === "text/plain") text = partValue.value;
    else bad.push(property);
  };
  if (value.bodyStructure !== undefined && value.bodyStructure !== null) {
    take(value.bodyStructure, "bodyStructure");
  }
  for (const property of ["textBody", "htmlBody"] as const) {
    const parts = value[property];
    if (parts === undefined || parts === null) continue;
    if (!Array.isArray(parts) || parts.length > 1) bad.push(property);
    else for (const part of parts) take(part, property);
  }
  if (Array.isArray(value.attachments)) {
    for (const part of value.attachments) {
      if (isObject(part)) attachmentParts.push(part);
      else bad.push("attachments");
    }
  } else if (value.attachments !== undefined && value.attachments !== null) {
    bad.push("attachments");
  }
  return { bodyText: text ?? "", bodyHtml: html, attachmentParts };
}

async function draftAttachments(ctx: RequestContext, parts: Args[]) {
  const attachments: DraftAttachment[] = [];
  const notFound: string[] = [];
  for (const part of parts) {
    const blob = await loadUploadedBlob(ctx.env, ctx.account.userId, part.blobId);
    if (!blob) {
      notFound.push(String(part.blobId));
      continue;
    }
    const inline = part.disposition === "inline" && typeof part.cid === "string";
    attachments.push({
      r2Key: blob.r2Key,
      name: typeof part.name === "string" ? part.name : "attachment",
      type: typeof part.type === "string" ? part.type : blob.contentType,
      size: blob.size,
      disposition: inline ? "inline" : "attachment",
      cid: inline ? part.cid as string : undefined,
    });
  }
  return { attachments, notFound };
}

async function createDraft(ctx: RequestContext, creationId: string, value: unknown): Promise<Args> {
  if (!ctx.submittedDraftRefs.has(creationId)) {
    return {
      type: "forbidden",
      description: "Drafts are not stored; create the Email and submit it with EmailSubmission/set in the same request",
    };
  }
  if (!isObject(value)) return { type: "invalidProperties" };
  const bad = Object.keys(value).filter((key) => !DRAFT_PROPERTIES.has(key));
  const from = draftAddresses(value.from, "from", bad);
  if (from.length !== 1) bad.push("from");
  const replyTo = draftAddresses(value.replyTo, "replyTo", bad);
  if (replyTo.length > 1) bad.push("replyTo");
  if (value.subject !== undefined && value.subject !== null && typeof value.subject !== "string") bad.push("subject");
  const idList = (property: string) => {
    const ids = value[property];
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      bad.push(property);
      return [];
    }
    return (ids as string[]).map((id) => `<${id}>`);
  };
  const { attachmentParts, ...body } = draftBody(value, bad);
  const draft: Omit<Draft, "attachments"> = {
    from: { email: from[0]?.email ?? "", name: from[0]?.name ?? null },
    to: draftAddresses(value.to, "to", bad).map((item) => item.email),
    cc: draftAddresses(value.cc, "cc", bad).map((item) => item.email),
    bcc: draftAddresses(value.bcc, "bcc", bad).map((item) => item.email),
    replyTo: replyTo[0]?.email,
    subject: typeof value.subject === "string" ? value.subject : "",
    ...body,
    inReplyTo: idList("inReplyTo"),
    references: idList("references"),
  };
  if (bad.length) return { type: "invalidProperties", properties: [...new Set(bad)] };
  const { attachments, notFound } = await draftAttachments(ctx, attachmentParts);
  if (notFound.length) return { type: "blobNotFound", notFound };
  const id = `draft_${crypto.randomUUID().replaceAll("-", "")}`;
  ctx.drafts.set(id, { ...draft, attachments });
  ctx.createdIds.set(creationId, id);
  const size = byteLength(draft.bodyText) + byteLength(draft.bodyHtml ?? "")
    + attachments.reduce((sum, file) => sum + file.size, 0);
  return { id, blobId: id, threadId: id, size };
}

async function emailSet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  setCount(args);
  const oldState = await currentState(ctx);
  checkIfInState(args, oldState);
  const created: Args = {};
  const notCreated: Args = {};
  const updated: Args = {};
  const notUpdated: Args = {};
  const destroyed: string[] = [];
  const notDestroyed: Args = {};

  for (const [creationId, value] of Object.entries(isObject(args.create) ? args.create : {})) {
    const result = await createDraft(ctx, creationId, value);
    if ("id" in result) created[creationId] = result;
    else notCreated[creationId] = result;
  }
  for (const [id, patch] of Object.entries(isObject(args.update) ? args.update : {})) {
    const error = await updateEmail(ctx, id, patch);
    if (error) notUpdated[id] = error;
    else updated[id] = null;
  }

  // Decide every destroy from the state before this call, so destroying two
  // messages of one Inbox conversation moves it to Trash only once.
  const destroyIds = Array.isArray(args.destroy) ? args.destroy as unknown[] : [];
  const { groups, notFound } = groupByMailbox(
    ctx,
    destroyIds.filter((id): id is string => typeof id === "string"),
  );
  for (const id of notFound) notDestroyed[id] = { type: "notFound" };
  for (const [mailboxId, items] of groups) {
    const rows = await loadEmailRows(ctx, mailboxId, items.map((item) => item.objectId));
    const byId = new Map(rows.map((row) => [row.email.id, row]));
    const handled = new Map<string, Args | null>();
    const stub = mailboxStub(ctx.env, mailboxId);
    for (const item of items) {
      const row = byId.get(item.objectId);
      if (!row) {
        notDestroyed[item.id] = { type: "notFound" };
        continue;
      }
      const conversationId = row.email.conversationId;
      if (!handled.has(conversationId)) {
        if (row.mailboxState === "trash") {
          if (!accountMailbox(ctx, mailboxId)!.canSend) {
            handled.set(conversationId, {
              type: "forbidden",
              description: "Send access is required to delete conversations permanently",
            });
          } else {
            const result = await stub.permanentlyDeleteConversations([conversationId]);
            handled.set(conversationId, result.outcome === "deleted" ? null : { type: "notFound" });
          }
        } else {
          const moved = await moveConversation(ctx, mailboxId, row, { mailboxState: "trash", folderId: row.folderId });
          handled.set(conversationId, moved ? null : { type: "serverFail", description: "Conversation changed; retry" });
        }
      }
      const error = handled.get(conversationId);
      if (error) notDestroyed[item.id] = error;
      else destroyed.push(item.id);
    }
  }

  return [["Email/set", {
    accountId: ctx.account.id,
    oldState: encodeState(oldState),
    newState: encodeState(await currentState(ctx)),
    created,
    updated,
    destroyed,
    notCreated,
    notUpdated,
    notDestroyed,
  }]];
}

// --- Email/import ---------------------------------------------------------

// An imported message starts its own Inbox conversation unless it threads
// into an existing one, whose placement mailboxIds then sets.
const IMPORTED_ROW = {
  email: { direction: "incoming" },
  mailboxState: "active",
  folderId: null,
  hasIncoming: true,
} as EmailRow;

async function importEmail(ctx: RequestContext, value: unknown): Promise<Args> {
  if (!isObject(value)) return { type: "invalidProperties" };
  const boxes = (isObject(value.mailboxIds) ? Object.entries(value.mailboxIds) : [])
    .flatMap(([key, enabled]) => (enabled === true ? [resolveMailboxId(ctx, key)] : []));
  const mailboxId = boxes[0]?.mailboxId;
  const target = mailboxId && boxes.every((box) => box?.mailboxId === mailboxId && box.box !== "top")
    ? placementFor(IMPORTED_ROW, boxes.map((box) => box!.box as LocalBox))
    : null;
  if (!mailboxId || !target) {
    return {
      type: "invalidProperties",
      properties: ["mailboxIds"],
      description: "Choose mailboxes of one OpenWorkspace mailbox that a received message can be in",
    };
  }
  // Importing writes mail that every member sees as received, so it needs the
  // same send access as composing; read-only members can only read and sort.
  if (!accountMailbox(ctx, mailboxId)!.canSend) {
    return { type: "forbidden", description: "Send access is required to import mail" };
  }
  if (value.keywords !== undefined && !isObject(value.keywords)) {
    return { type: "invalidProperties", properties: ["keywords"] };
  }
  let receivedAt = Date.now();
  if (value.receivedAt !== undefined && value.receivedAt !== null) {
    try {
      receivedAt = parseUtcDate(value.receivedAt, "receivedAt");
    } catch {
      return { type: "invalidProperties", properties: ["receivedAt"] };
    }
  }
  const blob = await loadUploadedBlob(ctx.env, ctx.account.userId, value.blobId);
  const object = blob ? await ctx.env.MAIL_STORAGE.get(blob.r2Key) : null;
  if (!object) return { type: "blobNotFound", notFound: [value.blobId] };
  const bytes = await object.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // The delivery id is the content hash, so importing the same bytes twice
  // into a mailbox finds the first copy.
  const deliveryId = `jmap_${hash}`;
  const stub = mailboxStub(ctx.env, mailboxId);
  const alreadyExists = (id: string) => ({ type: "alreadyExists", existingId: scopedId(mailboxId, id) });
  const existing = await stub.getEmail(inboundMessageId(deliveryId));
  if (existing) return alreadyExists(existing.id);
  const rawObjectKey = `mailboxes/${mailboxId}/raw/${deliveryId}.eml`;
  await ctx.env.MAIL_STORAGE.put(rawObjectKey, bytes, { httpMetadata: { contentType: "message/rfc822" } });
  const result = await stub.importJmapEmail({
    id: deliveryId,
    rawObjectKey,
    envelopeTo: accountMailbox(ctx, mailboxId)!.address,
    receivedAt,
  });
  if (!result) {
    await ctx.env.MAIL_STORAGE.delete(rawObjectKey);
    return { type: "invalidEmail", description: "The blob is not a parseable message" };
  }
  if (!result.created) return alreadyExists(result.email.id);
  const { email } = result;
  const [row] = await loadEmailRows(ctx, mailboxId, [email.id]);
  if (row) await moveConversation(ctx, mailboxId, row, target);
  // Keywords other than $seen are not stored.
  if (isObject(value.keywords) && value.keywords.$seen === true) {
    await stub.setMessageRead(ctx.account.userId, email.id, true);
  }
  return {
    id: scopedId(mailboxId, email.id),
    blobId: scopedId(mailboxId, email.id),
    threadId: scopedId(mailboxId, email.conversationId),
    size: bytes.byteLength,
  };
}

async function emailImport(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  if (!isObject(args.emails)) invalid("emails is required");
  if (Object.keys(args.emails).length > LIMITS.maxObjectsInSet) throw new MethodError("requestTooLarge");
  const oldState = await currentState(ctx);
  checkIfInState(args, oldState);
  const created: Args = {};
  const notCreated: Args = {};
  for (const [creationId, value] of Object.entries(args.emails)) {
    const result = await importEmail(ctx, value);
    if (typeof result.id === "string") {
      created[creationId] = result;
      ctx.createdIds.set(creationId, result.id);
    } else {
      notCreated[creationId] = result;
    }
  }
  return [["Email/import", {
    accountId: ctx.account.id,
    oldState: encodeState(oldState),
    newState: encodeState(await currentState(ctx)),
    created,
    notCreated,
  }]];
}

// --- SearchSnippet/get ----------------------------------------------------

function filterTerms(filter: unknown): string[] {
  if (!isObject(filter)) return [];
  if (Array.isArray(filter.conditions) && filter.operator !== "NOT") {
    return filter.conditions.flatMap(filterTerms);
  }
  return ["text", "subject", "body"].flatMap((key) =>
    typeof filter[key] === "string"
      ? ((filter[key] as string).normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])
      : []
  );
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function highlight(value: string, terms: string[]) {
  if (!terms.length) return null;
  const escapedTerms = terms.map((term) => escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const pattern = new RegExp(`(${escapedTerms.join("|")})`, "giu");
  const escaped = escapeHtml(value);
  return pattern.test(escaped) ? escaped.replace(pattern, "<mark>$1</mark>") : null;
}

async function searchSnippetGet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const ids = optionalIds(args, "emailIds");
  if (!ids) invalid("emailIds is required");
  const terms = filterTerms(args.filter);
  const { groups, notFound } = groupByMailbox(ctx, ids);
  const list: Args[] = [];
  for (const [mailboxId, items] of groups) {
    const rows = await loadEmailRows(ctx, mailboxId, items.map((item) => item.objectId));
    const byId = new Map(rows.map((row) => [row.email.id, row]));
    for (const item of items) {
      const row = byId.get(item.objectId);
      if (!row) notFound.push(item.id);
      else list.push({
        emailId: item.id,
        subject: highlight(row.email.subject, terms),
        preview: highlight(row.email.preview, terms),
      });
    }
  }
  return [["SearchSnippet/get", { accountId: ctx.account.id, list, notFound }]];
}

// ---------------------------------------------------------------------------
// Identities and submission

function identities(ctx: RequestContext) {
  return ctx.account.mailboxes.filter((mailbox) => mailbox.canSend).map((mailbox) => ({
    id: encodeIdPart(mailbox.id),
    name: mailbox.displayName,
    email: mailbox.address,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: false,
  }));
}

function identityState(ctx: RequestContext) {
  return identities(ctx).map((identity) => identity.id).join(",") || "none";
}

async function identityGet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const ids = optionalIds(args);
  const properties = selectedProperties(args, [
    "id", "name", "email", "replyTo", "bcc", "textSignature", "htmlSignature", "mayDelete",
  ]);
  const all = identities(ctx);
  const list = all.filter((identity) => !ids || ids.includes(identity.id));
  return [["Identity/get", {
    accountId: ctx.account.id,
    state: identityState(ctx),
    list: list.map((identity) => pick(identity, properties)),
    notFound: (ids ?? []).filter((id) => !all.some((identity) => identity.id === id)),
  }]];
}

async function identityChanges(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  if (args.sinceState !== identityState(ctx)) throw new MethodError("cannotCalculateChanges");
  return [["Identity/changes", {
    accountId: ctx.account.id,
    oldState: args.sinceState,
    newState: args.sinceState,
    hasMoreChanges: false,
    created: [],
    updated: [],
    destroyed: [],
  }]];
}

function resolveCreationReference(ctx: RequestContext, value: unknown) {
  if (typeof value !== "string") return null;
  return value.startsWith("#") ? ctx.createdIds.get(value.slice(1)) ?? null : value;
}

async function submitDraft(ctx: RequestContext, value: unknown): Promise<Args> {
  if (!isObject(value)) return { type: "invalidProperties" };
  const draftId = resolveCreationReference(ctx, value.emailId);
  const draft = draftId ? ctx.drafts.get(draftId) : undefined;
  if (!draftId || !draft) {
    return {
      type: "invalidProperties",
      properties: ["emailId"],
      description: "Only an Email created by Email/set earlier in this request can be submitted",
    };
  }
  const identityMailboxId = typeof value.identityId === "string" ? decodeIdPart(value.identityId) : null;
  const mailbox = identityMailboxId ? accountMailbox(ctx, identityMailboxId) : null;
  if (!mailbox) return { type: "invalidProperties", properties: ["identityId"] };
  if (!mailbox.canSend) return { type: "forbiddenToSend", description: "Send access is required" };
  if (draft.from.email.toLowerCase() !== mailbox.address.toLowerCase()) {
    return { type: "forbiddenFrom", description: "From must match the identity address" };
  }
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc].map((item) => item.toLowerCase());
  if (isObject(value.envelope)) {
    const envelope = value.envelope;
    const mailFrom = isObject(envelope.mailFrom) ? envelope.mailFrom.email : null;
    if (typeof mailFrom !== "string" || mailFrom.toLowerCase() !== mailbox.address.toLowerCase()) {
      return { type: "forbiddenMailFrom" };
    }
    const rcptTo = Array.isArray(envelope.rcptTo)
      ? envelope.rcptTo.flatMap((item) => (isObject(item) && typeof item.email === "string" ? [item.email.toLowerCase()] : []))
      : [];
    if (
      new Set(rcptTo).size !== new Set(recipients).size
      || rcptTo.some((address) => !recipients.includes(address))
    ) {
      return {
        type: "invalidProperties",
        properties: ["envelope"],
        description: "A custom envelope must match the To, Cc, and Bcc recipients",
      };
    }
  }
  if (!recipients.length) return { type: "noRecipients" };
  // Copy each uploaded blob into a composer upload of the sending mailbox so
  // the web composer's attachment path (limits, storage, cleanup) applies.
  const attachments = [];
  for (const file of draft.attachments) {
    const source = await ctx.env.MAIL_STORAGE.get(file.r2Key);
    if (!source) return { type: "invalidEmail", description: "An attachment blob has expired; upload it again" };
    const upload = await storeFinalizedComposerUpload({
      env: ctx.env,
      mailboxId: mailbox.id,
      userId: ctx.account.userId,
      filename: file.name,
      contentType: file.type,
      body: source.body,
    });
    attachments.push({ uploadId: upload.id, disposition: file.disposition, contentId: file.cid });
  }
  const compose = composeSchema.safeParse({
    requestId: crypto.randomUUID(),
    mailboxId: mailbox.id,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    replyTo: draft.replyTo,
    subject: draft.subject,
    bodyText: draft.bodyText,
    bodyHtml: draft.bodyHtml,
    attachments,
  });
  if (!compose.success) {
    return { type: "invalidEmail", description: compose.error.issues[0]?.message ?? "Message is invalid" };
  }
  const stub = mailboxStub(ctx.env, mailbox.id);
  const related = draft.inReplyTo.length || draft.references.length
    ? await stub.resolveParent(draft.inReplyTo, draft.references)
    : null;
  // Same send path as the web composer: validation, storage, transport, webhooks.
  let submission: Awaited<ReturnType<typeof submitOutgoing>>;
  try {
    submission = await submitOutgoing({
      env: ctx.env,
      requestUrl: ctx.requestUrl,
      fromAddress: mailbox.address,
      fromName: mailbox.displayName,
      compose: { ...compose.data, userId: ctx.account.userId },
      conversationId: related?.conversationId ?? createId("conv"),
      related,
      forwarded: null,
      includeRelatedContext: false,
      defer: ctx.defer,
    });
  } catch (error) {
    if (error instanceof ComposerAttachmentLimitError) return { type: "invalidEmail", description: error.message };
    throw error;
  }
  const email = submission.email;
  if (email.transportState === "failed") {
    return { type: "serverFail", description: email.transportError ?? "The message could not be sent" };
  }
  return {
    id: scopedId(mailbox.id, email.id),
    identityId: value.identityId,
    emailId: scopedId(mailbox.id, email.id),
    threadId: scopedId(mailbox.id, email.conversationId),
    envelope: null,
    sendAt: utcDate(email.timelineAt),
    undoStatus: "final",
    deliveryStatus: null,
    dsnBlobIds: [],
    mdnBlobIds: [],
    draftId,
  };
}

async function emailSubmissionSet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  setCount(args);
  const oldState = await currentState(ctx);
  checkIfInState(args, oldState);
  const created: Args = {};
  const notCreated: Args = {};
  const draftsBySubmission = new Map<string, string>();
  for (const [creationId, value] of Object.entries(isObject(args.create) ? args.create : {})) {
    const result = await submitDraft(ctx, value);
    if (typeof result.id !== "string") {
      notCreated[creationId] = result;
      continue;
    }
    const { draftId, ...submission } = result;
    created[creationId] = submission;
    ctx.createdIds.set(creationId, submission.id as string);
    draftsBySubmission.set(`#${creationId}`, draftId as string);
    draftsBySubmission.set(submission.id as string, draftId as string);
    ctx.drafts.delete(draftId as string);
  }
  const notUpdated = Object.fromEntries(
    Object.keys(isObject(args.update) ? args.update : {}).map((id) => [id, { type: "forbidden", description: "Sent submissions are final" }]),
  );
  const notDestroyed = Object.fromEntries(
    (Array.isArray(args.destroy) ? args.destroy : []).map((id) => [String(id), { type: "notFound" }]),
  );
  const responses: Response[] = [["EmailSubmission/set", {
    accountId: ctx.account.id,
    oldState: encodeState(oldState),
    newState: encodeState(await currentState(ctx)),
    created,
    updated: {},
    destroyed: [],
    notCreated,
    notUpdated,
    notDestroyed,
  }]];
  // Drafts only exist for the request; once sent, the stored outgoing message
  // replaces them, so both onSuccess forms report the draft as destroyed.
  const followUps = [
    ...(Array.isArray(args.onSuccessDestroyEmail) ? args.onSuccessDestroyEmail : []),
    ...Object.keys(isObject(args.onSuccessUpdateEmail) ? args.onSuccessUpdateEmail : {}),
  ].flatMap((reference) => {
    const draftId = draftsBySubmission.get(String(reference));
    return draftId ? [draftId] : [];
  });
  if (followUps.length) {
    const state = encodeState(await currentState(ctx));
    responses.push(["Email/set", {
      accountId: ctx.account.id,
      oldState: state,
      newState: state,
      created: {},
      updated: {},
      destroyed: [...new Set(followUps)],
      notCreated: {},
      notUpdated: {},
      notDestroyed: {},
    }]);
  }
  return responses;
}

async function emailSubmissionGet(ctx: RequestContext, args: Args): Promise<Response[]> {
  checkAccount(ctx, args);
  const ids = optionalIds(args);
  return [["EmailSubmission/get", {
    accountId: ctx.account.id,
    state: encodeState(await currentState(ctx)),
    list: [],
    notFound: ids ?? [],
  }]];
}

// ---------------------------------------------------------------------------

type Handler = (ctx: RequestContext, args: Args) => Promise<Response[]>;

const changesHandler = (name: string, type: JmapChangeType): Handler => async (ctx, args) => [
  [name, idChanges(ctx, await collectChanges(ctx, args, type))],
];

export const METHODS: Record<string, { capability: string; handler: Handler }> = {
  "Core/echo": { capability: CORE, handler: async (_ctx, args) => [["Core/echo", args]] },
  "Mailbox/get": { capability: MAIL, handler: mailboxGet },
  "Mailbox/changes": { capability: MAIL, handler: mailboxChanges },
  "Mailbox/query": { capability: MAIL, handler: mailboxQuery },
  "Mailbox/queryChanges": {
    capability: MAIL,
    handler: async () => {
      throw new MethodError("cannotCalculateChanges");
    },
  },
  "Mailbox/set": { capability: MAIL, handler: mailboxSet },
  "Thread/get": { capability: MAIL, handler: threadGet },
  "Thread/changes": { capability: MAIL, handler: changesHandler("Thread/changes", "Thread") },
  "Email/get": { capability: MAIL, handler: emailGet },
  "Email/changes": { capability: MAIL, handler: changesHandler("Email/changes", "Email") },
  "Email/query": { capability: MAIL, handler: emailQuery },
  "Email/queryChanges": { capability: MAIL, handler: emailQueryChanges },
  "Email/set": { capability: MAIL, handler: emailSet },
  "Email/import": { capability: MAIL, handler: emailImport },
  "SearchSnippet/get": { capability: MAIL, handler: searchSnippetGet },
  "Identity/get": { capability: SUBMISSION, handler: identityGet },
  "Identity/changes": { capability: SUBMISSION, handler: identityChanges },
  "EmailSubmission/get": { capability: SUBMISSION, handler: emailSubmissionGet },
  "EmailSubmission/set": { capability: SUBMISSION, handler: emailSubmissionSet },
};
