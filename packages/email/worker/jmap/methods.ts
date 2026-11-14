import {
  createDb,
  describeIssues,
  issueProperties,
} from "@open-workspace/core/module";
import type { Issue } from "@open-workspace/core/module";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { DRAFTS_FOLDER_ID } from "../../shared/folder-order";
import { MAX_COMPOSER_ATTACHMENT_COUNT } from "../../shared/mail";
import {
  importPlacements,
  MAX_IMPORT_MESSAGE_BYTES,
} from "../../shared/mail-import";
import {
  MAIL_ORGANIZE_SCOPE,
  MAIL_READ_SCOPE,
  MAIL_SEND_SCOPE,
} from "../../shared/permissions";
import { jmapPushSubscriptions } from "../db/schema";
import { storeDraft } from "../mail/draft-routes";
import { importRawMessage } from "../mail/import-routes";
import { submitOutgoing } from "../mail/outbound-service";
import { composeSchema, saveDraftSchema } from "../mail/schemas";
import {
  describeComposerUpload,
  loadComposerUpload,
  UploadValidationError,
} from "../mail/uploads";
import { mailboxStub } from "../mailbox";
import type { JmapEmailFilter, JmapMailboxRow } from "../mailbox/jmap-store";
import type { Email, Draft as StoredDraft } from "../mailbox/schema";
import {
  newVerificationCode,
  sendVerification,
  subscriptionExpiry,
} from "./push";
import type { PushVapid } from "./push";

const CORE = "urn:ietf:params:jmap:core";
const MAX_OBJECTS = 500;
const MAX_CALLS = 32;

export type JmapAccount = {
  id: string;
  address: string;
  displayName: string;
  ownerUserId: string | null;
  isPrimary: boolean;
  canSend: boolean;
  isPersonal: boolean;
};

export type JmapContext = {
  env: Env;
  user: { id: string; name: string };
  /** The OAuth client the token was issued to; push subscriptions belong to it. */
  clientId: string;
  /** The token's mail scopes; each method needs its own (`scopes` of its definition). */
  scopes: readonly string[];
  /** Signs pushes to Web Push services; null when push is not configured. */
  vapid: PushVapid | null;
  accounts: JmapAccount[];
  requestUrl: string;
  defer: (task: Promise<unknown>) => void;
};

type Json = z.core.util.JSONType;

type JsonObject = Record<string, Json>;

/** RFC 8620 §3.3: a request is the capabilities it uses and its method calls. */
export const jmapRequestSchema = z.object({
  using: z.array(z.string()),
  methodCalls: z.array(
    z.tuple([z.string(), z.record(z.string(), z.json()), z.string()])
  ),
  createdIds: z.record(z.string(), z.string()).optional(),
});

export type JmapRequest = z.output<typeof jmapRequestSchema>;

type Invocation = [string, JsonObject, string];

/** A request-level error (RFC 8620 §3.6.1), answered as a problem document. */
export class JmapError extends Error {
  constructor(
    readonly type: string,
    message: string
  ) {
    super(message);
  }
}

/** The method-level errors (RFC 8620 §3.6.2, RFC 8621) these methods answer with. */
const methodErrorTypes = z.enum([
  "accountNotFound",
  "cannotCalculateChanges",
  "forbidden",
  "invalidArguments",
  "invalidResultReference",
  "requestTooLarge",
  "stateMismatch",
  "unknownMethod",
  "unsupportedFilter",
  "unsupportedSort",
]);

type MethodErrorType = z.output<typeof methodErrorTypes>;

/** A method-level error, answered in place of the method's response. */
class MethodError extends Error {
  constructor(
    readonly type: MethodErrorType,
    message?: string
  ) {
    super(message ?? type);
  }
}

/** Uploaded blobs are named after their upload: `upl~<upload id>`. */
export const UPLOAD_BLOB = /^upl~(upl_[a-f0-9]{32})$/u;

/** An attachment of a draft: bytes from /jmap/upload. */
type DraftAttachment = {
  uploadId: string;
  name: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId: string | undefined;
};

/**
 * A draft from Email/set create; it lives only for the request that sends
 * it. It holds the message as the mail app's composer would send it.
 */
type Draft = {
  accountId: string;
  compose: z.output<typeof composeSchema>;
  attachments: DraftAttachment[];
};

/** The Email property a composer field comes from. */
function draftProperty(field: string) {
  if (field === "bodyText") return "textBody";

  if (field === "bodyHtml") return "htmlBody";

  return field;
}

/**
 * A composer issue, at the Email property it is about. Issues about the
 * message as a whole are about its recipients.
 */
function draftIssue(issue: Issue): Issue {
  const [field = "to", ...rest] = issue.path;

  return { ...issue, path: [draftProperty(String(field)), ...rest] };
}

type RequestState = {
  context: JmapContext;
  responses: Invocation[];
  createdIds: Map<string, string>;
  drafts: Map<string, Draft>;
  /** Responses a method adds after its own, e.g. an implicit Email/set. */
  after: Invocation[];
};

/** Arrays and objects are the JSON values a pointer steps into. */
function isJsonObject(value: Json): value is JsonObject {
  return Object(value) === value && !Array.isArray(value);
}

// ---------------------------------------------------------------- references

/** RFC 8620 §3.7: a JSON Pointer where `*` maps over an array. */
function evaluatePointer(value: Json, path: string): Json {
  if (path === "") return value;

  const [head = "", ...rest] = path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));

  const tail = rest.length ? `/${rest.join("/")}` : "";

  if (Array.isArray(value)) {
    if (head === "*") {
      return value.flatMap((item) => {
        const result = evaluatePointer(item, tail);

        return Array.isArray(result) ? result : [result];
      });
    }

    const item = /^\d+$/u.test(head) ? value[Number(head)] : undefined;

    if (item !== undefined) return evaluatePointer(item, tail);
  } else if (isJsonObject(value) && Object.hasOwn(value, head)) {
    const property = value[head];

    if (property !== undefined) return evaluatePointer(property, tail);
  }

  throw new MethodError(
    "invalidResultReference",
    `Path ${path} does not resolve`
  );
}

const resultReference = z.object({
  resultOf: z.string(),
  name: z.string(),
  path: z.string(),
});

function resolveReferences(state: RequestState, args: JsonObject) {
  const resolved: JsonObject = {};

  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      resolved[key] = value;
      continue;
    }

    const name = key.slice(1);

    if (Object.hasOwn(args, name)) {
      throw new MethodError(
        "invalidArguments",
        `Both ${name} and #${name} given`
      );
    }

    const reference = resultReference.safeParse(value);

    if (!reference.success) {
      throw new MethodError(
        "invalidResultReference",
        describeIssues(reference.error.issues)
      );
    }

    const { resultOf, name: methodName, path } = reference.data;

    const source = state.responses.find(
      ([response, , callId]) => callId === resultOf && response === methodName
    );

    if (!source) {
      throw new MethodError(
        "invalidResultReference",
        `No ${methodName} result for ${resultOf}`
      );
    }

    resolved[name] = evaluatePointer(source[1], path);
  }

  return resolved;
}

// ---------------------------------------------------------------- arguments

/**
 * Adds an issue that answers the method with `type` instead of
 * invalidArguments: the arguments are well formed, but ask for something
 * this server does not do.
 */
function methodIssue(
  context: z.RefinementCtx,
  type: MethodErrorType,
  message: string
) {
  context.addIssue({ code: "custom", message, params: { methodError: type } });
}

/** The method error an issue asks for, from `methodIssue`. */
function issueMethodError(issue: Issue) {
  if (issue.code !== "custom") return null;
  const type = methodErrorTypes.safeParse(issue.params?.methodError);

  return type.success ? type.data : null;
}

/** A method's arguments, or the method error that answers them (RFC 8620 §3.6.2). */
function parseArguments<Schema extends z.ZodType>(
  schema: Schema,
  args: JsonObject
): z.output<Schema> {
  const parsed = schema.safeParse(args);

  if (parsed.success) return parsed.data;
  const { issues } = parsed.error;

  for (const issue of issues) {
    const type = issueMethodError(issue);

    if (type) throw new MethodError(type, issue.message);
  }

  throw new MethodError("invalidArguments", describeIssues(issues));
}

const accountId = z.string();

/** Ids of objects to fetch or change; more than a request may hold is requestTooLarge. */
const idList = z.array(z.string()).superRefine((ids, context) => {
  if (ids.length > MAX_OBJECTS) {
    methodIssue(context, "requestTooLarge", `At most ${MAX_OBJECTS} ids`);
  }
});

const properties = z.array(z.string()).nullish();

/** RFC 8620 §1.4 UTCDate; an offset is accepted too. */
const utcDate = z.iso.datetime({ offset: true });

/** Objects to create or patches to apply, each checked on its own (SetError per id). */
const setObjects = z.record(z.string(), z.json()).nullish();

const changesArguments = z.object({ accountId, sinceState: z.string() });

/** A SetError for an object whose properties failed `issues` (RFC 8620 §5.3). */
function invalidProperties(
  issues: readonly Issue[],
  options: { topLevel?: boolean } = {}
) {
  const names = issueProperties(issues, options);

  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") names.push(...issue.keys);
  }

  return {
    type: "invalidProperties",
    properties: [...new Set(names)],
    description: describeIssues(issues),
  };
}

/** The `created`/`updated`/`not…` map of a /set response: null when empty. */
function setResult<Value extends Json>(entries: Map<string, Value>) {
  return entries.size ? Object.fromEntries(entries) : null;
}

// ------------------------------------------------------------------ helpers

/** The id a creation id stands for. */
function createdId(state: RequestState, creationId: string) {
  return state.createdIds.get(creationId);
}

function account(state: RequestState, id: string) {
  const found = state.context.accounts.find((item) => item.id === id);

  if (!found) throw new MethodError("accountNotFound");

  return found;
}

function pick<Value extends Json>(
  object: Record<string, Value>,
  wanted: readonly string[] | null | undefined
) {
  if (!wanted) return object;

  return Object.fromEntries(
    Object.entries(object).filter(
      ([key]) => key === "id" || wanted.includes(key)
    )
  );
}

/** We cannot list changes, only say whether anything changed. */
function changes(owner: JmapAccount, sinceState: string, state: string) {
  if (sinceState !== state) throw new MethodError("cannotCalculateChanges");

  return {
    accountId: owner.id,
    oldState: state,
    newState: state,
    hasMoreChanges: false,
    created: [],
    updated: [],
    destroyed: [],
  };
}

const addresses = (
  list: { address: string; name?: string | null }[] | null | undefined
) =>
  list?.length
    ? list.map((item) => ({ name: item.name || null, email: item.address }))
    : null;

// ------------------------------------------------------------------ mailbox

function mailboxObject(row: JmapMailboxRow, canSend: boolean) {
  return {
    id: row.id,
    name: row.name,
    parentId: null,
    role: row.role,
    sortOrder: row.sortOrder,
    totalEmails: row.totalEmails,
    unreadEmails: row.unreadEmails,
    totalThreads: row.totalThreads,
    unreadThreads: row.unreadThreads,
    myRights: {
      mayReadItems: true,
      mayAddItems: row.role !== "sent",
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: false,
      mayCreateChild: false,
      mayRename: false,
      mayDelete: false,
      maySubmit: canSend,
    },
    isSubscribed: true,
  };
}

const mailboxGetArguments = z.object({
  accountId,
  ids: idList.nullish(),
  properties,
});

async function mailboxGet(
  state: RequestState,
  args: z.output<typeof mailboxGetArguments>
) {
  const owner = account(state, args.accountId);

  const { state: mailboxState, mailboxes } = await mailboxStub(
    state.context.env,
    owner.id
  ).jmapMailboxes(state.context.user.id);

  const ids = args.ids ?? mailboxes.map((row) => row.id);
  const byId = new Map(mailboxes.map((row) => [row.id, row]));

  return {
    accountId: owner.id,
    state: mailboxState,
    list: ids.flatMap((id) => {
      const row = byId.get(id);

      return row
        ? [pick(mailboxObject(row, owner.canSend), args.properties)]
        : [];
    }),
    notFound: ids.filter((id) => !byId.has(id)),
  };
}

const mailboxQueryArguments = z.object({
  accountId,
  filter: z
    .object({
      /** null matches the mailboxes without a role. */
      role: z.string().nullable().optional(),
      name: z.string().optional(),
    })
    .nullish(),
});

async function mailboxQuery(
  state: RequestState,
  args: z.output<typeof mailboxQueryArguments>
) {
  const owner = account(state, args.accountId);

  const { state: mailboxState, mailboxes } = await mailboxStub(
    state.context.env,
    owner.id
  ).jmapMailboxes(state.context.user.id);

  const role = args.filter?.role;
  const name = args.filter?.name?.toLowerCase();

  const ids = mailboxes.flatMap((row) =>
    (role === undefined || row.role === role) &&
    (name === undefined || row.name.toLowerCase().includes(name))
      ? [row.id]
      : []
  );

  return {
    accountId: owner.id,
    queryState: mailboxState,
    canCalculateChanges: false,
    position: 0,
    ids,
    total: ids.length,
  };
}

// -------------------------------------------------------------------- email

/** The FilterCondition properties (RFC 8621 §4.4.1) Email/query supports. */
const emailCondition = {
  inMailbox: z.string().optional(),
  inMailboxOtherThan: z.array(z.string()).optional(),
  before: utcDate.transform((date) => Date.parse(date)).optional(),
  after: utcDate.transform((date) => Date.parse(date)).optional(),
  text: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  hasKeyword: z.string().optional(),
  notKeyword: z.string().optional(),
  hasAttachment: z.boolean().optional(),
};

const emailConditionKeys = Object.keys(emailCondition);

/**
 * An Email/query filter, flattened into one condition. Other conditions,
 * operators than AND, and keywords than $seen are valid JMAP the store
 * cannot answer: unsupportedFilter.
 */
const emailFilter: z.ZodType<JmapEmailFilter> = z.lazy(() =>
  z
    .record(z.string(), z.unknown())
    .superRefine((filter, context) => {
      const allowed = Object.hasOwn(filter, "operator")
        ? ["operator", "conditions"]
        : emailConditionKeys;

      const unsupported = Object.keys(filter).filter(
        (key) => !allowed.includes(key)
      );

      if (unsupported.length) {
        methodIssue(
          context,
          "unsupportedFilter",
          `Unsupported filter: ${unsupported.join(", ")}`
        );
      }
    })
    .pipe(
      z.object({
        operator: z.enum(["AND", "OR", "NOT"]).optional(),
        conditions: z.array(emailFilter).optional(),
        ...emailCondition,
      })
    )
    .superRefine((filter, context) => {
      if (filter.operator && filter.operator !== "AND") {
        methodIssue(
          context,
          "unsupportedFilter",
          "Only AND filters are supported"
        );
      }

      if (filter.operator && !filter.conditions) {
        context.addIssue({
          code: "custom",
          path: ["conditions"],
          message: "A filter operator needs conditions",
        });
      }

      for (const keyword of [filter.hasKeyword, filter.notKeyword]) {
        if (keyword !== undefined && keyword !== "$seen") {
          methodIssue(
            context,
            "unsupportedFilter",
            "Only the $seen keyword is supported"
          );
        }
      }
    })
    .transform(({ operator, conditions, ...condition }) => {
      if (!operator) return condition;
      // AND: every condition holds.
      const merged: JmapEmailFilter = {};

      for (const part of conditions ?? []) Object.assign(merged, part);

      return merged;
    })
);

const emailComparator = z
  .object({
    property: z.string(),
    isAscending: z.boolean().optional(),
    collation: z.string().optional(),
  })
  .superRefine((comparator, context) => {
    if (!["receivedAt", "sentAt"].includes(comparator.property)) {
      methodIssue(
        context,
        "unsupportedSort",
        "Emails sort by receivedAt or sentAt"
      );
    }
  });

const emailQueryArguments = z.object({
  accountId,
  filter: emailFilter.nullish(),
  sort: z.array(emailComparator).nullish(),
  position: z.number().int().nullish(),
  limit: z.number().int().min(0).nullish(),
  collapseThreads: z.boolean().nullish(),
});

async function emailQuery(
  state: RequestState,
  args: z.output<typeof emailQueryArguments>
) {
  const owner = account(state, args.accountId);
  const ascending = args.sort?.[0]?.isAscending === true;
  // Negative positions (from the end) are not supported; they start at the top.
  const position = Math.max(0, args.position ?? 0);
  const limit = Math.min(MAX_OBJECTS, args.limit ?? 100);

  const result = await mailboxStub(state.context.env, owner.id).jmapQueryEmails(
    {
      userId: state.context.user.id,
      filter: args.filter ?? {},
      ascending,
      position,
      limit,
      collapseThreads: args.collapseThreads === true,
    }
  );

  return {
    accountId: owner.id,
    queryState: result.state,
    canCalculateChanges: false,
    position,
    ids: result.ids,
    total: result.total,
    limit,
  };
}

const defaultEmailProperties = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
];

const emailGetArguments = z.object({
  accountId,
  ids: idList.nullish(),
  properties,
  fetchTextBodyValues: z.boolean().nullish(),
  fetchHTMLBodyValues: z.boolean().nullish(),
  fetchAllBodyValues: z.boolean().nullish(),
  maxBodyValueBytes: z.number().int().min(0).nullish(),
});

type EmailGetArguments = z.output<typeof emailGetArguments>;

/** A body value as Email/get returns it, cut to maxBodyValueBytes. */
function bodyValueOf(value: string, args: EmailGetArguments) {
  const maxBytes = args.maxBodyValueBytes ?? 0;

  return {
    value:
      maxBytes && value.length > maxBytes ? value.slice(0, maxBytes) : value,
    isEncodingProblem: false,
    isTruncated: Boolean(maxBytes && value.length > maxBytes),
  };
}

/**
 * One of the person's drafts as an Email in the drafts mailbox, with the
 * $draft keyword. Its files download as the uploads they were (`upl~`).
 */
function draftEmailObject(
  owner: JmapAccount,
  draft: StoredDraft,
  args: EmailGetArguments
) {
  const part = (partId: string, type: string, value: string) => ({
    partId,
    blobId: `draft~${draft.id}`,
    size: value.length,
    name: null,
    type,
    charset: "utf-8",
    disposition: null,
    cid: null,
  });

  const textBody = [part("text", "text/plain", draft.bodyText)];

  const htmlBody = draft.bodyHtml
    ? [part("html", "text/html", draft.bodyHtml)]
    : textBody;

  const attachments = draft.attachments.map((file) => ({
    partId: `att-${file.uploadId}`,
    blobId: `upl~${file.uploadId}`,
    size: file.size,
    name: file.filename,
    type: file.contentType,
    charset: null,
    disposition: file.disposition,
    cid: file.contentId,
  }));

  const wanted = args.properties ?? defaultEmailProperties;
  const bodyValues: Record<string, ReturnType<typeof bodyValueOf>> = {};

  if (wanted.includes("bodyValues")) {
    const all = args.fetchAllBodyValues === true;

    if (all || args.fetchTextBodyValues === true || !draft.bodyHtml) {
      bodyValues.text = bodyValueOf(draft.bodyText, args);
    }

    if ((all || args.fetchHTMLBodyValues === true) && draft.bodyHtml) {
      bodyValues.html = bodyValueOf(draft.bodyHtml, args);
    }
  }

  const timestamp = draft.updatedAt.toISOString();

  const list = (values: string[]) =>
    addresses(values.map((address) => ({ address })));

  return pick(
    {
      id: draft.id,
      blobId: `draft~${draft.id}`,
      threadId:
        draft.kind === "reply" && draft.conversationId
          ? draft.conversationId
          : draft.id,
      mailboxIds: { [DRAFTS_FOLDER_ID]: true },
      keywords: { $draft: true, $seen: true },
      size:
        draft.bodyText.length +
        attachments.reduce((total, file) => total + file.size, 0),
      receivedAt: timestamp,
      messageId: null,
      inReplyTo: null,
      references: null,
      sender: null,
      from: [{ name: owner.displayName || null, email: owner.address }],
      to: list(draft.to),
      cc: list(draft.cc),
      bcc: list(draft.bcc),
      replyTo: draft.replyTo ? list([draft.replyTo]) : null,
      subject: draft.subject,
      sentAt: timestamp,
      hasAttachment: attachments.some(
        (file) => file.disposition === "attachment"
      ),
      preview: draft.bodyText.replaceAll(/\s+/gu, " ").trim().slice(0, 256),
      bodyValues,
      textBody,
      htmlBody,
      attachments,
      bodyStructure: {
        partId: null,
        type: "multipart/mixed",
        subParts: [...htmlBody, ...attachments],
      },
    },
    wanted
  );
}

async function emailObject(
  env: Env,
  row: { email: Email; mailboxId: string; seen: boolean },
  args: EmailGetArguments
) {
  const { email } = row;
  const raw = `raw~${email.id}`;

  const textBody = [
    {
      partId: "text",
      blobId: raw,
      size: email.bodyText?.length ?? 0,
      name: null,
      type: "text/plain",
      charset: "utf-8",
      disposition: null,
      cid: null,
    },
  ];

  const htmlBody = email.bodyHtmlR2Key
    ? [
        {
          partId: "html",
          blobId: raw,
          size: 0,
          name: null,
          type: "text/html",
          charset: "utf-8",
          disposition: null,
          cid: null,
        },
      ]
    : textBody;

  const attachments = email.attachmentsJson.map((attachment) => ({
    partId: `att-${attachment.id}`,
    blobId: `att~${email.id}~${attachment.id}`,
    size: attachment.size,
    name: attachment.filename,
    type: attachment.contentType,
    charset: null,
    disposition: attachment.disposition,
    cid: attachment.contentId,
  }));

  const wanted = args.properties ?? defaultEmailProperties;
  const bodyValue = (value: string) => bodyValueOf(value, args);
  const bodyValues: Record<string, ReturnType<typeof bodyValue>> = {};

  if (wanted.includes("bodyValues")) {
    const wantText =
      args.fetchTextBodyValues === true || args.fetchAllBodyValues === true;

    const wantHtml =
      args.fetchHTMLBodyValues === true || args.fetchAllBodyValues === true;

    if (wantText || (wantHtml && !email.bodyHtmlR2Key)) {
      bodyValues.text = bodyValue(email.bodyText ?? "");
    }

    if (wantHtml && email.bodyHtmlR2Key) {
      const object = await env.MAIL_STORAGE.get(email.bodyHtmlR2Key);
      bodyValues.html = bodyValue(object ? await object.text() : "");
    }
  }

  const timestamp = email.timelineAt.toISOString();
  const keywords: Record<string, true> = row.seen ? { $seen: true } : {};

  const object = {
    id: email.id,
    blobId: raw,
    threadId: email.conversationId,
    mailboxIds: { [row.mailboxId]: true },
    keywords,
    size:
      (email.bodyText?.length ?? 0) +
      email.attachmentsJson.reduce(
        (total, attachment) => total + attachment.size,
        0
      ),
    receivedAt: timestamp,
    messageId: email.messageIdHeader
      ? [email.messageIdHeader.replaceAll(/^<|>$/gu, "")]
      : null,
    inReplyTo: email.inReplyToJson?.length ? email.inReplyToJson : null,
    references: email.referencesJson?.length ? email.referencesJson : null,
    sender: null,
    from: addresses(email.fromJson),
    to: addresses(email.toJson),
    cc: addresses(email.ccJson),
    bcc: addresses(email.bccJson),
    replyTo: addresses(email.replyToJson),
    subject: email.subject,
    sentAt: timestamp,
    hasAttachment: attachments.some(
      (attachment) => attachment.disposition === "attachment"
    ),
    preview: email.preview,
    bodyValues,
    textBody,
    htmlBody,
    attachments,
    bodyStructure: {
      partId: null,
      type: "multipart/mixed",
      subParts: [...htmlBody, ...attachments],
    },
  };

  return pick(object, wanted);
}

async function emailGet(state: RequestState, args: EmailGetArguments) {
  const owner = account(state, args.accountId);

  if (!args.ids) {
    throw new MethodError("requestTooLarge", "Ask for emails by id");
  }

  const { ids } = args;

  const result = await mailboxStub(state.context.env, owner.id).jmapEmails(
    state.context.user.id,
    ids
  );

  const found = new Set([
    ...result.emails.map((row) => row.email.id),
    ...result.drafts.map((draft) => draft.id),
  ]);

  return {
    accountId: owner.id,
    state: result.state,
    list: [
      ...(await Promise.all(
        result.emails.map((row) => emailObject(state.context.env, row, args))
      )),
      ...result.drafts.map((draft) => draftEmailObject(owner, draft, args)),
    ],
    notFound: ids.filter((id) => !found.has(id)),
  };
}

/** A patch key is a JSON Pointer into the email (RFC 8620 §5.3). */
function patchPath(key: string) {
  return key
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Keywords and mailboxIds map their names to true (RFC 8621 §4.1.1). */
const trueSet = z.record(z.string(), z.literal(true));

/** One entry of a set: true adds it, null removes it. */
const setMember = z.literal(true).nullable();

/**
 * An Email/set update patch: the $seen keyword and the one mailbox an email
 * is in are all that change.
 */
const emailPatch = z
  .record(z.string(), z.json())
  .transform((patch, context) => {
    let seen: boolean | undefined;
    let target: string | undefined;

    for (const [key, value] of Object.entries(patch)) {
      const path = patchPath(key);

      const fail = (message: string) =>
        context.addIssue({ code: "custom", path, message, input: value });

      if (key === "keywords") {
        const keywords = trueSet.safeParse(value);

        if (!keywords.success) fail("keywords map keywords to true");
        else if (Object.keys(keywords.data).some((name) => name !== "$seen")) {
          fail("Only the $seen keyword is stored");
        } else seen = Object.hasOwn(keywords.data, "$seen");
      } else if (key === "keywords/$seen") {
        const member = setMember.safeParse(value);

        if (member.success) seen = member.data === true;
        else fail("A keyword is set to true or null");
      } else if (key.startsWith("keywords/")) {
        fail("Only the $seen keyword is stored");
      } else if (key === "mailboxIds") {
        const mailboxIds = trueSet.safeParse(value);
        const ids = mailboxIds.success ? Object.keys(mailboxIds.data) : [];

        if (ids.length === 1) [target] = ids;
        else fail("An email is in exactly one mailbox");
      } else if (key.startsWith("mailboxIds/")) {
        const member = setMember.safeParse(value);

        if (!member.success) fail("A mailbox is set to true or null");
        else if (member.data) target = key.slice("mailboxIds/".length);
      } else {
        fail(`${key} cannot be changed`);
      }
    }

    return { seen, target };
  });

const draftAddress = z.object({
  name: z.string().nullish(),
  email: z.string(),
});

const draftAddresses = z
  .array(draftAddress)
  .nullish()
  .transform((list) => list?.map((item) => item.email) ?? []);

/** A body part of a draft names its value in bodyValues. */
const draftBodyPart = z.array(z.object({ partId: z.string() })).nullish();

const draftAttachment = z
  .object({
    blobId: z
      .string()
      .regex(UPLOAD_BLOB, "Attachments must be blobs uploaded to this account")
      .transform((blobId) => blobId.replace(UPLOAD_BLOB, "$1")),
    name: z.string().nullish(),
    type: z.string().nullish(),
    disposition: z.string().nullish(),
    cid: z
      .string()
      .nullish()
      .transform((cid) => cid?.replaceAll(/^<|>$/gu, "") || undefined),
  })
  .superRefine((part, context) => {
    if (part.disposition === "inline" && !part.cid) {
      context.addIssue({
        code: "custom",
        path: ["cid"],
        message: "Inline attachments need a cid",
      });
    }
  })
  .transform((part): DraftAttachment => ({
    uploadId: part.blobId,
    name: part.name ?? "attachment",
    type: part.type ?? "application/octet-stream",
    disposition: part.disposition === "inline" ? "inline" : "attachment",
    contentId: part.disposition === "inline" ? part.cid : undefined,
  }));

/** An Email/set create object (RFC 8621 §4.6): a message to send in this request. */
const draftSchema = z
  .object({
    to: draftAddresses,
    cc: draftAddresses,
    bcc: draftAddresses,
    subject: z.string().nullish(),
    bodyValues: z.record(z.string(), z.object({ value: z.string() })).nullish(),
    textBody: draftBodyPart,
    htmlBody: draftBodyPart,
    attachments: z
      .array(draftAttachment)
      .max(
        MAX_COMPOSER_ATTACHMENT_COUNT,
        `At most ${MAX_COMPOSER_ATTACHMENT_COUNT} attachments per message`
      )
      .nullish()
      .transform((list) => list ?? [])
      .refine(
        (list) =>
          new Set(list.map((item) => item.uploadId)).size === list.length,
        "Each blob can be attached once"
      ),
  })
  .transform((input, context) => {
    const values = new Map(Object.entries(input.bodyValues ?? {}));

    const partText = (parts: { partId: string }[] | null | undefined) => {
      const [first] = parts ?? [];

      return first ? values.get(first.partId)?.value : undefined;
    };

    const bodyText = partText(input.textBody);
    const bodyHtml = partText(input.htmlBody);

    if (bodyText === undefined && bodyHtml === undefined) {
      context.addIssue({
        code: "custom",
        path: ["textBody"],
        message: "Give the message a textBody or htmlBody with bodyValues",
      });
    }

    return {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject ?? "",
      bodyText: bodyText ?? "",
      bodyHtml,
      attachments: input.attachments,
    };
  });

/** Whether an Email/set create puts the email in the drafts mailbox, to keep it. */
function inDraftsMailbox(input: Json) {
  return (
    isJsonObject(input) &&
    isJsonObject(input.mailboxIds ?? null) &&
    isJsonObject(input.mailboxIds) &&
    input.mailboxIds[DRAFTS_FOLDER_ID] === true
  );
}

const isStoredDraftId = (id: string) => id.startsWith("drf_");

/**
 * Keeps a mail app's draft (Email/set create in the drafts mailbox) as one
 * of the person's drafts, which the web app lists too. Returns its id, or
 * the SetError it was not created with.
 */
async function createStoredDraft(
  state: RequestState,
  owner: JmapAccount,
  input: Json
): Promise<{ id: string; size: number } | { error: JsonObject }> {
  if (!owner.canSend) {
    return {
      error: { type: "forbidden", description: "This account cannot send" },
    };
  }

  const parsed = draftSchema.safeParse(input);

  if (!parsed.success) {
    return {
      error: invalidProperties(parsed.error.issues, { topLevel: true }),
    };
  }

  const { attachments, ...message } = parsed.data;

  try {
    await Promise.all(
      attachments.map((attachment) =>
        describeComposerUpload({
          env: state.context.env,
          mailboxId: owner.id,
          userId: state.context.user.id,
          uploadId: attachment.uploadId,
          filename: attachment.name,
          contentType: attachment.type,
        })
      )
    );
  } catch (error) {
    if (!(error instanceof UploadValidationError)) throw error;

    return { error: { type: "blobNotFound", description: error.message } };
  }

  const save = saveDraftSchema.safeParse({
    ...message,
    expectedVersion: 0,
    kind: "compose",
    bodyHtml: message.bodyHtml ?? null,
    attachments: attachments.map((attachment) => ({
      assetId: crypto.randomUUID(),
      uploadId: attachment.uploadId,
      disposition: attachment.disposition,
      contentId: attachment.contentId,
    })),
  });

  if (!save.success) {
    return {
      error: invalidProperties(save.error.issues.map(draftIssue), {
        topLevel: true,
      }),
    };
  }

  const id = `drf_${crypto.randomUUID()}`;

  const result = await storeDraft(
    {
      env: state.context.env,
      user: state.context.user,
      mailbox: { id: owner.id, ownerUserId: owner.ownerUserId },
    },
    id,
    save.data
  );

  if (result.status === "saved") {
    return { id, size: result.draft.bodyText.length };
  }

  if (result.status === "limit") {
    return {
      error: {
        type: "overQuota",
        description: "Too many drafts: send or discard some first",
      },
    };
  }

  return {
    error: {
      type: "invalidProperties",
      properties: ["attachments"],
      description:
        result.status === "invalid" ? result.message : "Draft was not saved",
    },
  };
}

/**
 * Why an Email/set update of a draft can't apply, or null: a draft's
 * content can't change (a mail app replaces it with a new one), and it stays
 * in the drafts mailbox with $draft until it is sent.
 */
function draftPatchError(patch: Json): JsonObject | null {
  if (!isJsonObject(patch)) {
    return { type: "invalidPatch", description: "A patch is an object" };
  }

  for (const [key, value] of Object.entries(patch)) {
    const keeps =
      (key === "keywords" && isJsonObject(value) && value.$draft === true) ||
      (key === "keywords/$draft" && value === true) ||
      key === "keywords/$seen" ||
      (key === "mailboxIds" &&
        isJsonObject(value) &&
        Object.keys(value).join(",") === DRAFTS_FOLDER_ID) ||
      (key === `mailboxIds/${DRAFTS_FOLDER_ID}` && value === true);

    if (!keeps) {
      return {
        type: "invalidProperties",
        properties: [patchPath(key)[0] ?? key],
        description:
          "A draft stays in Drafts until it is sent; save a new draft to change it",
      };
    }
  }

  return null;
}

const emailSetArguments = z.object({
  accountId,
  ifInState: z.string().nullish(),
  create: setObjects,
  update: setObjects,
  destroy: idList.nullish(),
});

type EmailSetArguments = z.output<typeof emailSetArguments>;

/** Email/set creates drafts only to send them; changing or destroying mail is organizing. */
function emailSetScopes(args: EmailSetArguments) {
  const scopes: string[] = [];

  if (args.create && Object.keys(args.create).length) {
    scopes.push(MAIL_SEND_SCOPE);
  }

  if (
    (args.update && Object.keys(args.update).length) ||
    args.destroy?.length
  ) {
    scopes.push(MAIL_ORGANIZE_SCOPE);
  }

  return scopes;
}

async function emailSet(state: RequestState, args: EmailSetArguments) {
  const owner = account(state, args.accountId);
  const stub = mailboxStub(state.context.env, owner.id);
  const oldState = await stub.jmapState();

  if (args.ifInState != null && args.ifInState !== oldState) {
    throw new MethodError("stateMismatch");
  }

  const created = new Map<string, JsonObject>();
  const notCreated = new Map<string, JsonObject>();

  const creations = Object.entries(args.create ?? {});

  // In the drafts mailbox: a draft to keep, as the web app's drafts are.
  for (const [creationId, input] of creations.filter(([, object]) =>
    inDraftsMailbox(object)
  )) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- drafts are saved in the order the client gave them
    const stored = await createStoredDraft(state, owner, input);

    if ("error" in stored) {
      notCreated.set(creationId, stored.error);
      continue;
    }

    state.createdIds.set(creationId, stored.id);
    created.set(creationId, {
      id: stored.id,
      blobId: `draft~${stored.id}`,
      threadId: stored.id,
      size: stored.size,
    });
  }

  // Anywhere else: a message to send in this request, never stored.
  const drafts = creations
    .filter(([, object]) => !inDraftsMailbox(object))
    .flatMap(([creationId, input]) => {
      const parsed = draftSchema.safeParse(input);

      if (!parsed.success) {
        notCreated.set(
          creationId,
          invalidProperties(parsed.error.issues, { topLevel: true })
        );

        return [];
      }

      const { attachments, ...message } = parsed.data;

      // The rules the mail app's composer follows: valid, normalized and
      // deduplicated recipients within the limits, a body, content ids.
      const compose = composeSchema.safeParse({
        ...message,
        requestId: crypto.randomUUID(),
        mailboxId: owner.id,
        attachments: attachments.map((attachment) => ({
          uploadId: attachment.uploadId,
          disposition: attachment.disposition,
          contentId: attachment.contentId,
        })),
      });

      if (!compose.success) {
        notCreated.set(
          creationId,
          invalidProperties(compose.error.issues.map(draftIssue), {
            topLevel: true,
          })
        );

        return [];
      }

      return [
        {
          creationId,
          draft: { accountId: owner.id, compose: compose.data, attachments },
        },
      ];
    });

  const missingBlobs = await Promise.all(
    drafts.map(async ({ draft }) => {
      try {
        // The name and type come with the email, after the bytes were uploaded.
        await Promise.all(
          draft.attachments.map((attachment) =>
            describeComposerUpload({
              env: state.context.env,
              mailboxId: owner.id,
              userId: state.context.user.id,
              uploadId: attachment.uploadId,
              filename: attachment.name,
              contentType: attachment.type,
            })
          )
        );

        return null;
      } catch (error) {
        if (!(error instanceof UploadValidationError)) throw error;

        return error.message;
      }
    })
  );

  for (const [index, { creationId, draft }] of drafts.entries()) {
    const missing = missingBlobs[index];

    if (missing) {
      notCreated.set(creationId, {
        type: "blobNotFound",
        description: missing,
      });
      continue;
    }

    // Drafts are not stored: one is sent by EmailSubmission/set in the same request.
    const id = `draft-${crypto.randomUUID()}`;
    state.drafts.set(id, draft);
    state.createdIds.set(creationId, id);
    created.set(creationId, {
      id,
      blobId: `draft~${id}`,
      threadId: id,
      size: draft.compose.bodyText.length,
    });
  }

  const updated = new Map<string, null>();
  const notUpdated = new Map<string, JsonObject>();
  const reads: [string, boolean][] = [];
  const moves = new Map<string, string[]>();

  const updates = Object.entries(args.update ?? {});

  const draftUpdates = updates.filter(([id]) => isStoredDraftId(id));

  const draftsFound = await Promise.all(
    draftUpdates.map(([id]) => stub.getDraft(state.context.user.id, id))
  );

  for (const [index, [id, patch]] of draftUpdates.entries()) {
    const error = draftsFound[index]
      ? draftPatchError(patch)
      : { type: "notFound" };

    if (error) notUpdated.set(id, error);
    else updated.set(id, null);
  }

  for (const [id, patch] of updates.filter(
    ([emailId]) => !isStoredDraftId(emailId)
  )) {
    const change = emailPatch.safeParse(patch);

    if (!change.success) {
      notUpdated.set(
        id,
        change.error.issues.some((issue) => issue.path.length === 0)
          ? { type: "invalidPatch", description: "A patch is an object" }
          : invalidProperties(change.error.issues)
      );
      continue;
    }

    const { seen, target } = change.data;

    if (seen !== undefined) reads.push([id, seen]);

    if (target) moves.set(target, [...(moves.get(target) ?? []), id]);
    updated.set(id, null);
  }

  const readResults = await Promise.all(
    reads.map(([id, seen]) =>
      stub.setMessageRead(state.context.user.id, id, seen)
    )
  );

  for (const [index, [id]] of reads.entries()) {
    if (!readResults[index]) {
      updated.delete(id);
      notUpdated.set(id, { type: "notFound" });
    }
  }

  const moveTargets = [...moves];

  const moved = await Promise.all(
    moveTargets.map(([target, ids]) => stub.jmapMoveEmails(ids, target))
  );

  for (const [index, [target, ids]] of moveTargets.entries()) {
    if (moved[index]) continue;

    for (const id of ids) {
      updated.delete(id);
      notUpdated.set(id, {
        type: "invalidProperties",
        properties: ["mailboxIds"],
        description: `Emails cannot be moved to ${target}`,
      });
    }
  }

  const destroyed: string[] = [];
  const notDestroyed = new Map<string, JsonObject>();
  const draftDestroyIds = (args.destroy ?? []).filter(isStoredDraftId);

  const draftsDeleted = await Promise.all(
    draftDestroyIds.map((id) => stub.deleteDraft(state.context.user.id, id))
  );

  for (const [index, id] of draftDestroyIds.entries()) {
    if (draftsDeleted[index]) destroyed.push(id);
    else notDestroyed.set(id, { type: "notFound" });
  }

  const destroyIds = (args.destroy ?? []).filter((id) => !isStoredDraftId(id));

  if (destroyIds.length) {
    const { emails } = await stub.jmapEmails(state.context.user.id, destroyIds);
    const inTrash = emails.filter((row) => row.mailboxId === "trash");
    const elsewhere = emails.filter((row) => row.mailboxId !== "trash");

    // Mail goes to Trash first; destroying it there deletes its conversation.
    if (elsewhere.length) {
      await stub.jmapMoveEmails(
        elsewhere.map((row) => row.email.id),
        "trash"
      );
    }

    if (inTrash.length) {
      await stub.permanentlyDeleteConversations([
        ...new Set(inTrash.map((row) => row.email.conversationId)),
      ]);
    }

    const found = new Set(emails.map((row) => row.email.id));

    for (const id of destroyIds) {
      if (found.has(id)) destroyed.push(id);
      else notDestroyed.set(id, { type: "notFound" });
    }
  }

  return {
    accountId: owner.id,
    oldState,
    newState: await stub.jmapState(),
    created: setResult(created),
    updated: setResult(updated),
    destroyed: destroyed.length ? destroyed : null,
    notCreated: setResult(notCreated),
    notUpdated: setResult(notUpdated),
    notDestroyed: setResult(notDestroyed),
  };
}

// ------------------------------------------------------------------ import

/** An Email/import object (RFC 8621 §4.8): an uploaded message, its one mailbox and $seen. */
const emailImportObject = z.object({
  blobId: z.string(),
  mailboxIds: trueSet
    .transform((ids) => Object.keys(ids))
    .refine((ids) => ids.length === 1, "An email is in exactly one mailbox"),
  keywords: trueSet
    .nullish()
    .refine(
      (keywords) =>
        Object.keys(keywords ?? {}).every((name) => name === "$seen"),
      "Only the $seen keyword is stored"
    ),
  receivedAt: utcDate.nullish(),
});

const emailImportArguments = z.object({
  accountId,
  ifInState: z.string().nullish(),
  emails: z.record(z.string(), z.json()).superRefine((emails, context) => {
    if (Object.keys(emails).length > MAX_OBJECTS) {
      methodIssue(context, "requestTooLarge", `At most ${MAX_OBJECTS} emails`);
    }
  }),
});

type EmailImportArguments = z.output<typeof emailImportArguments>;

/** The bytes of a blob uploaded to this account, or null when there is none. */
async function uploadedBlob(
  state: RequestState,
  owner: JmapAccount,
  blobId: string
) {
  const upload = UPLOAD_BLOB.exec(blobId);

  if (!upload) return null;

  try {
    return await loadComposerUpload({
      env: state.context.env,
      mailboxId: owner.id,
      userId: state.context.user.id,
      uploadId: upload[1],
    });
  } catch (error) {
    if (error instanceof UploadValidationError) return null;
    throw error;
  }
}

/**
 * Stores uploaded messages as the import CLI does: their date, mailbox and
 * read state kept, threaded, no AI, webhooks or push. A message imported
 * before (the same bytes or Message-ID) is alreadyExists.
 */
async function emailImport(state: RequestState, args: EmailImportArguments) {
  const owner = account(state, args.accountId);
  const { env, user } = state.context;

  // Imported mail shows as received, so only its owner may add to a mailbox (as with the CLI).
  if (!owner.isPersonal) {
    throw new MethodError(
      "forbidden",
      "Mail can be imported only into your own mailboxes"
    );
  }

  const stub = mailboxStub(env, owner.id);
  const oldState = await stub.jmapState();

  if (args.ifInState != null && args.ifInState !== oldState) {
    throw new MethodError("stateMismatch");
  }

  const { mailboxes } = await stub.jmapMailboxes(user.id);
  const created = new Map<string, JsonObject>();
  const notCreated = new Map<string, JsonObject>();

  for (const [creationId, input] of Object.entries(args.emails)) {
    const parsed = emailImportObject.safeParse(input);

    if (!parsed.success) {
      notCreated.set(creationId, invalidProperties(parsed.error.issues));
      continue;
    }

    const { blobId, mailboxIds, keywords, receivedAt } = parsed.data;
    const target = mailboxes.find((row) => row.id === mailboxIds[0]);

    if (!target) {
      notCreated.set(creationId, {
        type: "invalidProperties",
        properties: ["mailboxIds"],
        description: "No such mailbox",
      });
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time, so a message given twice is stored once
    const upload = await uploadedBlob(state, owner, blobId);

    if (upload && upload.size > MAX_IMPORT_MESSAGE_BYTES) {
      notCreated.set(creationId, {
        type: "tooLarge",
        description: `Messages are limited to ${MAX_IMPORT_MESSAGE_BYTES / 1024 / 1024} MiB`,
      });
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    const object = upload ? await env.MAIL_STORAGE.get(upload.r2Key) : null;

    if (!object) {
      notCreated.set(creationId, { type: "blobNotFound", notFound: [blobId] });
      continue;
    }

    const placement =
      importPlacements.find((place) => place === target.id) ?? "inbox";

    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    const raw = new Uint8Array(await object.arrayBuffer());

    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    const result = await importRawMessage({
      env,
      mailbox: owner,
      raw,
      importKey: raw,
      receivedAt: receivedAt ? Date.parse(receivedAt) : null,
      placement,
      folderName: target.role === null ? target.name : null,
      seen: Object.hasOwn(keywords ?? {}, "$seen"),
      thread: null,
      // The mailbox asked for decides, not the From address.
      direction:
        placement === "sent"
          ? "outgoing"
          : placement === "inbox"
            ? "incoming"
            : null,
    });

    if (result.status === "unprocessable") {
      notCreated.set(creationId, {
        type: "invalidEmail",
        description: result.reason,
      });
    } else if (result.status === "duplicate") {
      notCreated.set(creationId, {
        type: "alreadyExists",
        existingId: result.id,
      });
    } else {
      state.createdIds.set(creationId, result.id);
      created.set(creationId, {
        id: result.id,
        blobId: `raw~${result.id}`,
        threadId: result.conversationId,
        size: raw.byteLength,
      });
    }
  }

  // Announces the imports now (counts, open apps, JMAP state), not with the alarm.
  if (created.size) await stub.finishImport();

  return {
    accountId: owner.id,
    oldState,
    newState: await stub.jmapState(),
    created: setResult(created),
    notCreated: setResult(notCreated),
  };
}

// --------------------------------------------------- threads and identities

const threadGetArguments = z.object({ accountId, ids: idList });

async function threadGet(
  state: RequestState,
  args: z.output<typeof threadGetArguments>
) {
  const owner = account(state, args.accountId);

  const result = await mailboxStub(state.context.env, owner.id).jmapThreads(
    args.ids
  );

  const threads = new Map(
    result.threads.map((thread) => [thread.id, thread.emailIds])
  );

  return {
    accountId: owner.id,
    state: result.state,
    list: args.ids.flatMap((id) => {
      const emailIds = threads.get(id);

      return emailIds ? [{ id, emailIds }] : [];
    }),
    notFound: args.ids.filter((id) => !threads.has(id)),
  };
}

const identityGetArguments = z.object({
  accountId,
  ids: idList.nullish(),
  properties,
});

function identityGet(
  state: RequestState,
  args: z.output<typeof identityGetArguments>
) {
  const owner = account(state, args.accountId);

  const list = owner.canSend
    ? [
        {
          id: owner.id,
          name: owner.displayName,
          email: owner.address,
          replyTo: null,
          bcc: null,
          textSignature: "",
          htmlSignature: "",
          mayDelete: false,
        },
      ]
    : [];

  const ids = args.ids ?? list.map((identity) => identity.id);

  return {
    accountId: owner.id,
    state: "1",
    list: list.flatMap((identity) =>
      ids.includes(identity.id) ? [pick(identity, args.properties)] : []
    ),
    notFound: ids.filter((id) => id !== owner.id || !owner.canSend),
  };
}

const submissionCreate = z.object({
  emailId: z.string(),
  identityId: z.string().optional(),
});

const submissionSetArguments = z.object({
  accountId,
  create: setObjects,
  onSuccessDestroyEmail: z.array(z.string()).nullish(),
  onSuccessUpdateEmail: z.record(z.string(), z.json()).nullish(),
});

const notADraft = {
  type: "invalidProperties",
  properties: ["emailId"],
  description:
    "Send a draft, or an email created by Email/set earlier in the same request",
};

/**
 * A kept draft as a message to send, checked as the composer's would be.
 * Replies and forwards started in the web app depend on the message they
 * answer, so they are sent from there.
 */
async function storedDraftMessage(
  state: RequestState,
  owner: JmapAccount,
  id: string
): Promise<{ draft: Draft } | { error: JsonObject }> {
  const stored = await mailboxStub(state.context.env, owner.id).getDraft(
    state.context.user.id,
    id
  );

  if (!stored) return { error: notADraft };

  if (stored.kind !== "compose") {
    return {
      error: {
        ...notADraft,
        description:
          "Replies and forwards saved in the web app are sent from the web app",
      },
    };
  }

  const compose = composeSchema.safeParse({
    requestId: crypto.randomUUID(),
    mailboxId: owner.id,
    to: stored.to,
    cc: stored.cc,
    bcc: stored.bcc,
    replyTo: stored.replyTo ?? undefined,
    subject: stored.subject,
    bodyText: stored.bodyText,
    bodyHtml: stored.bodyHtml ?? undefined,
    attachments: stored.attachments.map((file) => ({
      uploadId: file.uploadId,
      disposition: file.disposition,
      contentId: file.contentId ?? undefined,
    })),
  });

  if (!compose.success) {
    return {
      error: invalidProperties(compose.error.issues.map(draftIssue), {
        topLevel: true,
      }),
    };
  }

  return {
    draft: { accountId: owner.id, compose: compose.data, attachments: [] },
  };
}

/** Sends a draft as the account; a failure is the reason it was not sent. */
async function sendDraft(
  state: RequestState,
  owner: JmapAccount,
  draft: Draft
) {
  try {
    return await submitOutgoing({
      env: state.context.env,
      requestUrl: state.context.requestUrl,
      compose: { ...draft.compose, userId: state.context.user.id },
      conversationId: `conv_${crypto.randomUUID().replaceAll("-", "")}`,
      related: null,
      forwarded: null,
      includeRelatedContext: false,
      fromAddress: owner.address,
      fromName: owner.displayName,
      defer: state.context.defer,
    });
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "The message could not be sent",
    };
  }
}

async function submissionSet(
  state: RequestState,
  args: z.output<typeof submissionSetArguments>,
  callId: string
) {
  const owner = account(state, args.accountId);

  if (!owner.canSend) {
    throw new MethodError("forbidden", "This account cannot send");
  }

  const created = new Map<string, JsonObject>();
  const notCreated = new Map<string, JsonObject>();
  const sentDrafts = new Map<string, string>();

  for (const [creationId, input] of Object.entries(args.create ?? {})) {
    const parsed = submissionCreate.safeParse(input);

    if (!parsed.success) {
      notCreated.set(creationId, invalidProperties(parsed.error.issues));
      continue;
    }

    const submission = parsed.data;

    const emailId = submission.emailId.startsWith("#")
      ? createdId(state, submission.emailId.slice(1))
      : submission.emailId;

    const sendable =
      emailId !== undefined && isStoredDraftId(emailId)
        ? // oxlint-disable-next-line eslint/no-await-in-loop -- submissions send mail in the order the client gave them
          await storedDraftMessage(state, owner, emailId)
        : {
            draft:
              emailId === undefined ? undefined : state.drafts.get(emailId),
          };

    if ("error" in sendable) {
      notCreated.set(creationId, sendable.error);
      continue;
    }

    const { draft } = sendable;

    if (emailId === undefined || !draft || draft.accountId !== owner.id) {
      notCreated.set(creationId, notADraft);
      continue;
    }

    if (
      submission.identityId !== undefined &&
      submission.identityId !== owner.id
    ) {
      notCreated.set(creationId, {
        type: "invalidProperties",
        properties: ["identityId"],
        description: "Unknown identity",
      });
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- submissions send mail in the order the client gave them
    const sent = await sendDraft(state, owner, draft);

    if ("error" in sent) {
      notCreated.set(creationId, {
        type: "forbiddenToSend",
        description: sent.error,
      });
      continue;
    }

    const id = `sub-${sent.email.id}`;
    state.createdIds.set(creationId, id);
    sentDrafts.set(id, emailId);
    created.set(creationId, {
      id,
      threadId: sent.email.conversationId,
      emailId: sent.email.id,
      sendAt: new Date().toISOString(),
      undoStatus: "final",
    });
  }

  // The sent copy is already in Sent: the follow-up Email/set deletes a
  // kept draft, and only reports one created for this request gone.
  const followUp = [
    ...(args.onSuccessDestroyEmail ?? []),
    ...Object.keys(args.onSuccessUpdateEmail ?? {}),
  ].flatMap((reference) => {
    const id = reference.startsWith("#")
      ? createdId(state, reference.slice(1))
      : reference;

    const draftId = id === undefined ? undefined : sentDrafts.get(id);

    return draftId === undefined ? [] : [draftId];
  });

  if (followUp.length) {
    const stub = mailboxStub(state.context.env, owner.id);
    const current = await stub.jmapState();

    await Promise.all(
      followUp.flatMap((id) =>
        isStoredDraftId(id) ? [stub.deleteDraft(state.context.user.id, id)] : []
      )
    );

    state.after.push([
      "Email/set",
      {
        accountId: owner.id,
        oldState: current,
        newState: await stub.jmapState(),
        created: null,
        updated: null,
        destroyed: followUp,
        notCreated: null,
        notUpdated: null,
        notDestroyed: null,
      },
      callId,
    ]);
  }

  return {
    accountId: owner.id,
    oldState: "1",
    newState: "1",
    created: setResult(created),
    notCreated: setResult(notCreated),
    updated: null,
    destroyed: null,
    notUpdated: null,
    notDestroyed: null,
  };
}

// --------------------------------------------------------- push (RFC 8620 §7.2)

const MAX_PUSH_SUBSCRIPTIONS = 20;

type PushSubscriptionRow = typeof jmapPushSubscriptions.$inferSelect;

/** url and keys are never returned (§7.2.1). */
function pushSubscriptionObject(row: PushSubscriptionRow) {
  return {
    id: row.id,
    deviceClientId: row.deviceClientId,
    verificationCode: row.verifiedAt ? row.verificationCode : null,
    expires: row.expiresAt.toISOString(),
    types: row.typesJson,
  };
}

/** The data types to push; null is all of them. */
const pushTypes = z.array(z.string()).nullish();

/** A PushSubscription create object (RFC 8620 §7.2). */
const pushSubscriptionCreate = z.object({
  deviceClientId: z.string().min(1),
  url: z
    .url({ protocol: /^https$/u, error: "url must be an https URL" })
    .transform((url) => new URL(url).toString()),
  keys: z.object({ p256dh: z.string(), auth: z.string() }).nullish(),
  verificationCode: z
    .never({ error: "verificationCode is set by update" })
    .optional(),
  expires: utcDate.nullish(),
  types: pushTypes,
});

/** Only these change after a subscription is created. */
const pushSubscriptionPatch = z.strictObject({
  verificationCode: z.string().optional(),
  expires: utcDate.nullish(),
  types: pushTypes,
});

function ownSubscriptions(state: RequestState) {
  return and(
    eq(jmapPushSubscriptions.userId, state.context.user.id),
    eq(jmapPushSubscriptions.clientId, state.context.clientId)
  );
}

const pushSubscriptionGetArguments = z.object({
  ids: idList.nullish(),
  properties,
});

async function pushSubscriptionGet(
  state: RequestState,
  args: z.output<typeof pushSubscriptionGetArguments>
) {
  const db = createDb(state.context.env.DB);
  const ids = args.ids ?? null;

  const rows = await db
    .select()
    .from(jmapPushSubscriptions)
    .where(
      ids
        ? and(
            ownSubscriptions(state),
            inArray(jmapPushSubscriptions.id, ids.length ? ids : [""])
          )
        : ownSubscriptions(state)
    );

  const found = new Set(rows.map((row) => row.id));

  return {
    list: rows.map((row) => pick(pushSubscriptionObject(row), args.properties)),
    notFound: ids ? ids.filter((id) => !found.has(id)) : [],
  };
}

const pushSubscriptionSetArguments = z.object({
  /** Push subscriptions have no state (§7.2): any given state mismatches. */
  ifInState: z.string().nullish(),
  create: setObjects,
  update: setObjects,
  destroy: idList.nullish(),
});

async function createPushSubscriptions(
  state: RequestState,
  create: JsonObject
) {
  const db = createDb(state.context.env.DB);
  const created = new Map<string, JsonObject>();
  const notCreated = new Map<string, JsonObject>();
  const entries = Object.entries(create);

  if (!entries.length) return { created, notCreated };

  // The devices with a subscription; a device has one, and a new one replaces it.
  const devices = new Set(
    (
      await db
        .select({ deviceClientId: jmapPushSubscriptions.deviceClientId })
        .from(jmapPushSubscriptions)
        .where(eq(jmapPushSubscriptions.userId, state.context.user.id))
    ).map((row) => row.deviceClientId)
  );

  const rows: PushSubscriptionRow[] = [];

  for (const [creationId, input] of entries) {
    const parsed = pushSubscriptionCreate.safeParse(input);

    if (!parsed.success) {
      notCreated.set(creationId, invalidProperties(parsed.error.issues));
      continue;
    }

    const subscription = parsed.data;

    if (subscription.keys && !state.context.vapid) {
      notCreated.set(creationId, {
        type: "invalidProperties",
        properties: ["keys"],
        description: "Web Push is not configured on this server",
      });
      continue;
    }

    const others =
      devices.size - (devices.has(subscription.deviceClientId) ? 1 : 0);

    if (others >= MAX_PUSH_SUBSCRIPTIONS) {
      notCreated.set(creationId, {
        type: "overQuota",
        description: `At most ${MAX_PUSH_SUBSCRIPTIONS} push subscriptions`,
      });
      continue;
    }

    devices.add(subscription.deviceClientId);

    const row: PushSubscriptionRow = {
      id: crypto.randomUUID(),
      userId: state.context.user.id,
      clientId: state.context.clientId,
      deviceClientId: subscription.deviceClientId,
      url: subscription.url,
      p256dh: subscription.keys?.p256dh ?? null,
      auth: subscription.keys?.auth ?? null,
      verificationCode: newVerificationCode(),
      verifiedAt: null,
      expiresAt: subscriptionExpiry(subscription.expires),
      typesJson: subscription.types ?? null,
      createdAt: new Date(),
    };

    rows.push(row);
    state.createdIds.set(creationId, row.id);
    created.set(creationId, {
      id: row.id,
      expires: row.expiresAt.toISOString(),
    });
  }

  // In order: a later subscription for the same device replaces an earlier one.
  const [first, ...rest] = rows.flatMap((row) => [
    db
      .delete(jmapPushSubscriptions)
      .where(
        and(
          eq(jmapPushSubscriptions.userId, row.userId),
          eq(jmapPushSubscriptions.deviceClientId, row.deviceClientId)
        )
      ),
    db.insert(jmapPushSubscriptions).values(row),
  ]);

  if (first) await db.batch([first, ...rest]);

  for (const row of rows) {
    state.context.defer(
      sendVerification(row, state.context.vapid).catch((error) => {
        console.error(
          "Could not send JMAP push verification",
          error instanceof Error ? error.message : String(error)
        );
      })
    );
  }

  return { created, notCreated };
}

async function updatePushSubscriptions(
  state: RequestState,
  update: JsonObject
) {
  const db = createDb(state.context.env.DB);
  const updated = new Map<string, JsonObject | null>();
  const notUpdated = new Map<string, JsonObject>();
  const entries = Object.entries(update);

  if (!entries.length) return { updated, notUpdated };

  const rows = new Map(
    (
      await db
        .select()
        .from(jmapPushSubscriptions)
        .where(
          and(
            ownSubscriptions(state),
            inArray(
              jmapPushSubscriptions.id,
              entries.map(([id]) => id)
            )
          )
        )
    ).map((row) => [row.id, row])
  );

  const changed: Pick<
    PushSubscriptionRow,
    "id" | "verifiedAt" | "expiresAt" | "typesJson"
  >[] = [];

  for (const [id, input] of entries) {
    const row = rows.get(id);

    if (!row) {
      notUpdated.set(id, { type: "notFound" });
      continue;
    }

    const parsed = pushSubscriptionPatch.safeParse(input);

    if (!parsed.success) {
      notUpdated.set(id, invalidProperties(parsed.error.issues));
      continue;
    }

    const patch = parsed.data;

    if (
      patch.verificationCode !== undefined &&
      patch.verificationCode !== row.verificationCode
    ) {
      notUpdated.set(id, {
        type: "invalidProperties",
        properties: ["verificationCode"],
        description: "The verification code does not match",
      });
      continue;
    }

    const expiresAt =
      patch.expires === undefined
        ? row.expiresAt
        : subscriptionExpiry(patch.expires);

    changed.push({
      id,
      verifiedAt:
        patch.verificationCode === undefined
          ? row.verifiedAt
          : (row.verifiedAt ?? new Date()),
      expiresAt,
      typesJson: patch.types === undefined ? row.typesJson : patch.types,
    });

    // The server may shorten the asked expiry; then it says what it chose.
    const askedExpiry = patch.expires ? Date.parse(patch.expires) : null;

    updated.set(
      id,
      askedExpiry !== null && askedExpiry !== expiresAt.getTime()
        ? { expires: expiresAt.toISOString() }
        : null
    );
  }

  const [first, ...rest] = changed.map(({ id, ...values }) =>
    db
      .update(jmapPushSubscriptions)
      .set(values)
      .where(eq(jmapPushSubscriptions.id, id))
  );

  if (first) await db.batch([first, ...rest]);

  return { updated, notUpdated };
}

async function pushSubscriptionSet(
  state: RequestState,
  args: z.output<typeof pushSubscriptionSetArguments>
) {
  const db = createDb(state.context.env.DB);

  if (args.ifInState != null) throw new MethodError("stateMismatch");

  const { created, notCreated } = await createPushSubscriptions(
    state,
    args.create ?? {}
  );

  const { updated, notUpdated } = await updatePushSubscriptions(
    state,
    args.update ?? {}
  );

  const destroyIds = args.destroy ?? [];

  const removed = destroyIds.length
    ? await db
        .delete(jmapPushSubscriptions)
        .where(
          and(
            ownSubscriptions(state),
            inArray(jmapPushSubscriptions.id, destroyIds)
          )
        )
        .returning({ id: jmapPushSubscriptions.id })
    : [];

  const destroyed = new Set(removed.map((row) => row.id));
  const notDestroyed = new Map<string, JsonObject>();

  for (const id of destroyIds) {
    if (!destroyed.has(id)) notDestroyed.set(id, { type: "notFound" });
  }

  return {
    created: setResult(created),
    updated: setResult(updated),
    destroyed: destroyed.size ? [...destroyed] : null,
    notCreated: setResult(notCreated),
    notUpdated: setResult(notUpdated),
    notDestroyed: setResult(notDestroyed),
  };
}

// ----------------------------------------------------------------- dispatch

type MethodHandler = (
  state: RequestState,
  args: JsonObject,
  callId: string
) => JsonObject | Promise<JsonObject>;

/**
 * A method: its arguments' schema, the mail scopes a call needs (each
 * method needs its own), and what it does with the parsed arguments.
 */
function method<Schema extends z.ZodType>(definition: {
  arguments: Schema;
  scopes: (args: z.output<Schema>) => readonly string[];
  run: (
    state: RequestState,
    args: z.output<Schema>,
    callId: string
  ) => JsonObject | Promise<JsonObject>;
}): MethodHandler {
  return (state, raw, callId) => {
    const args = parseArguments(definition.arguments, raw);

    const missing = definition
      .scopes(args)
      .filter((scope) => !state.context.scopes.includes(scope));

    if (missing.length) {
      throw new MethodError(
        "forbidden",
        `This token was not given ${missing.join(", ")}`
      );
    }

    return definition.run(state, args, callId);
  };
}

const reading = () => [MAIL_READ_SCOPE];

/** Foo/changes for the types that share the mailbox's one state. */
const mailboxChanges = method({
  arguments: changesArguments,
  scopes: reading,
  run: async (state, args) => {
    const owner = account(state, args.accountId);

    return changes(
      owner,
      args.sinceState,
      await mailboxStub(state.context.env, owner.id).jmapState()
    );
  },
});

const methods = new Map<string, MethodHandler>([
  [
    "Core/echo",
    method({
      arguments: z.record(z.string(), z.json()),
      scopes: () => [],
      run: (_state, args) => args,
    }),
  ],
  [
    "Mailbox/get",
    method({
      arguments: mailboxGetArguments,
      scopes: reading,
      run: mailboxGet,
    }),
  ],
  [
    "Mailbox/query",
    method({
      arguments: mailboxQueryArguments,
      scopes: reading,
      run: mailboxQuery,
    }),
  ],
  ["Mailbox/changes", mailboxChanges],
  [
    "Email/query",
    method({
      arguments: emailQueryArguments,
      scopes: reading,
      run: emailQuery,
    }),
  ],
  [
    "Email/get",
    method({ arguments: emailGetArguments, scopes: reading, run: emailGet }),
  ],
  [
    "Email/set",
    method({
      arguments: emailSetArguments,
      scopes: emailSetScopes,
      run: emailSet,
    }),
  ],
  [
    "Email/import",
    method({
      arguments: emailImportArguments,
      scopes: () => [MAIL_ORGANIZE_SCOPE],
      run: emailImport,
    }),
  ],
  ["Email/changes", mailboxChanges],
  [
    "Thread/get",
    method({ arguments: threadGetArguments, scopes: reading, run: threadGet }),
  ],
  ["Thread/changes", mailboxChanges],
  [
    "SearchSnippet/get",
    method({
      arguments: z.object({ accountId, emailIds: idList }),
      scopes: reading,
      run: (state, args) => ({
        accountId: account(state, args.accountId).id,
        list: args.emailIds.map((emailId) => ({
          emailId,
          subject: null,
          preview: null,
        })),
        notFound: [],
      }),
    }),
  ],
  [
    "Identity/get",
    method({
      arguments: identityGetArguments,
      scopes: reading,
      run: identityGet,
    }),
  ],
  [
    "EmailSubmission/set",
    method({
      arguments: submissionSetArguments,
      scopes: () => [MAIL_SEND_SCOPE],
      run: submissionSet,
    }),
  ],
  [
    "PushSubscription/get",
    method({
      arguments: pushSubscriptionGetArguments,
      scopes: reading,
      run: pushSubscriptionGet,
    }),
  ],
  [
    "PushSubscription/set",
    method({
      arguments: pushSubscriptionSetArguments,
      scopes: reading,
      run: pushSubscriptionSet,
    }),
  ],
]);

/** RFC 8620 §3.4. */
type JmapResponse = {
  methodResponses: Invocation[];
  createdIds?: Record<string, string>;
  sessionState: string;
};

/** Runs a parsed request's method calls (RFC 8620 §3.3). */
export async function runJmapRequest(
  context: JmapContext,
  request: JmapRequest
) {
  if (!request.using.includes(CORE)) {
    throw new JmapError(
      "urn:ietf:params:jmap:error:unknownCapability",
      `${CORE} is required`
    );
  }

  if (request.methodCalls.length > MAX_CALLS) {
    throw new JmapError(
      "urn:ietf:params:jmap:error:limit",
      `At most ${MAX_CALLS} method calls per request`
    );
  }

  const state: RequestState = {
    context,
    responses: [],
    createdIds: new Map(Object.entries(request.createdIds ?? {})),
    drafts: new Map(),
    after: [],
  };

  for (const [name, rawArgs, callId] of request.methodCalls) {
    const handler = methods.get(name);

    try {
      if (!handler) throw new MethodError("unknownMethod");

      // oxlint-disable-next-line eslint/no-await-in-loop -- a call may reference the results of earlier ones (RFC 8620 §3.7), so calls run in order
      const result = await handler(
        state,
        resolveReferences(state, rawArgs),
        callId
      );

      state.responses.push([name, result, callId], ...state.after.splice(0));
    } catch (error) {
      if (!(error instanceof MethodError)) throw error;
      state.responses.push([
        "error",
        { type: error.type, description: error.message },
        callId,
      ]);
    }
  }

  const response: JmapResponse = {
    methodResponses: state.responses,
    sessionState: String(context.accounts.length),
  };

  // Only a request that sent createdIds gets them back (§3.4).
  if (request.createdIds) {
    response.createdIds = Object.fromEntries(state.createdIds);
  }

  return response;
}
