import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  responseJson,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { mailApi } from "../lib/mail-api";
import type {
  MailFolder,
  MailRule,
  MailRuleInput,
  MessageDetail,
} from "./types";
import { useFolders } from "./use-mail-data";

type Condition = MailRuleInput["conditions"][number];

type Action = MailRuleInput["actions"][number];

const conditionLabels: Record<Condition["type"], string> = {
  from: "From",
  recipient: "To or Cc",
  subject: "Subject",
  listId: "Mailing list",
  hasAttachment: "Has attachment",
};

const actionLabels: Record<Action["type"], string> = {
  moveToFolder: "Move to folder",
  archive: "Archive",
  trash: "Move to Trash",
  spam: "Move to Spam",
  notSpam: "Never send to Spam",
  markRead: "Mark as read",
};

const opLabels = {
  contains: "contains",
  equals: "is",
  domain: "domain is",
  exists: "exists",
} as const;

type Op = keyof typeof opLabels;

function conditionOps(type: Condition["type"]): Op[] {
  if (type === "from") return ["contains", "equals", "domain"];

  if (type === "listId") return ["exists", "contains"];

  return type === "hasAttachment" ? [] : ["contains", "equals"];
}

function defaultCondition(type: Condition["type"]): Condition {
  switch (type) {
    case "from":
    case "recipient":
    case "subject": {
      return { type, op: "contains", value: "" };
    }

    case "listId": {
      return { type, op: "exists" };
    }

    default: {
      return { type: "hasAttachment" };
    }
  }
}

function defaultAction(type: Action["type"], folders: MailFolder[]): Action {
  return type === "moveToFolder"
    ? { type, folderId: folders[0]?.id ?? "" }
    : { type };
}

function placeholder(condition: Condition) {
  if (condition.type === "subject") return "invoice";

  if (condition.type === "listId") return "news.example.com";

  if ("op" in condition && condition.op === "domain") return "example.com";

  if ("op" in condition && condition.op === "equals") {
    return "name@example.com";
  }

  return condition.type === "from" ? "@example.com" : "billing@";
}

/** A condition that compares against text the person has to type. */
function needsValue(condition: Condition) {
  return "op" in condition && condition.op !== "exists";
}

function describeCondition(condition: Condition) {
  if (condition.type === "hasAttachment") return "it has an attachment";

  if (condition.type === "listId" && condition.op === "exists") {
    return "it comes from a mailing list";
  }

  const label = conditionLabels[condition.type].toLowerCase();

  return `${label} ${opLabels[condition.op]} “${condition.value ?? ""}”`;
}

function describeAction(action: Action, folders: MailFolder[]) {
  if (action.type === "moveToFolder") {
    const folder = folders.find((item) => item.id === action.folderId);

    return `move to ${folder?.name ?? "a deleted folder"}`;
  }

  return actionLabels[action.type].toLowerCase();
}

const valueErrors = {
  from: "Enter an address, part of one, or a domain",
  recipient: "Enter an address or part of one",
  subject: "Enter some text",
  listId: "Enter part of the list ID",
  hasAttachment: null,
};

/** What's wrong with a draft, by field; nothing set means it can be saved. */
function draftErrors(draft: MailRuleInput, folders: MailFolder[]) {
  return {
    name: draft.name.trim() ? null : "Give the rule a name",
    conditions: draft.conditions.map((condition) =>
      needsValue(condition) && "value" in condition && !condition.value?.trim()
        ? valueErrors[condition.type]
        : null
    ),
    actions: draft.actions.map((action) =>
      action.type === "moveToFolder" &&
      !folders.some((folder) => folder.id === action.folderId)
        ? "Pick a folder"
        : null
    ),
  };
}

type DraftErrors = ReturnType<typeof draftErrors>;

function hasErrors(errors: DraftErrors) {
  return Boolean(
    errors.name ||
    errors.conditions.some(Boolean) ||
    errors.actions.some(Boolean)
  );
}

/** One of core's Selects over a fixed list of labelled options. */
function Choice<T extends string>({
  label,
  value,
  options,
  invalid,
  describedBy,
  placeholder: empty,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  onChange: (value: T) => void;
}) {
  const selected = options.find(([option]) => option === value);

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      >
        <SelectValue>
          {selected ? (
            selected[1]
          ) : (
            <span className="text-muted-foreground">{empty}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {options.map(([option, text]) => (
          <SelectItem key={option} value={option}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FieldError({ id, error }: { id: string; error: string | null }) {
  return error ? (
    <p id={id} className="text-destructive w-full text-xs">
      {error}
    </p>
  ) : null;
}

const emptyRule: MailRuleInput = {
  name: "",
  enabled: true,
  match: "all",
  conditions: [{ type: "from", op: "contains", value: "" }],
  actions: [{ type: "archive" }],
  stopProcessing: false,
};

function ruleInput(rule: MailRule): MailRuleInput {
  return {
    name: rule.name,
    enabled: rule.enabled,
    match: rule.match,
    conditions: rule.conditions,
    actions: rule.actions,
    stopProcessing: rule.stopProcessing,
  };
}

/** A new rule for mail like this message: its sender, and its list if any. */
function filterDraft(message: MessageDetail): MailRuleInput {
  const conditions: Condition[] = [
    { type: "from", op: "equals", value: message.fromAddress },
  ];

  if (message.listId) {
    conditions.push({ type: "listId", op: "contains", value: message.listId });
  }

  return {
    ...emptyRule,
    name: `Mail from ${message.listId ?? message.fromAddress}`,
    conditions,
  };
}

/** Rules tab: ordered deterministic rules for new mail, with an inline editor. */
export function MailboxRules({
  mailboxId,
  folders,
  active,
}: {
  mailboxId: string;
  folders: MailFolder[];
  active: boolean;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<MailRule | "new" | null>(null);
  const customFolders = folders.filter((folder) => folder.kind === "custom");
  const route = mailApi.api.mail.mailboxes[":id"].rules;
  const queryKey = ["mailbox-rules", mailboxId];

  const rules = useQuery({
    queryKey,
    queryFn: async () =>
      (await responseJson(await route.$get({ param: { id: mailboxId } })))
        .rules,
    enabled: active,
  });

  const change = useMutation({
    mutationFn: async (
      operation:
        | { type: "toggle"; rule: MailRule; enabled: boolean }
        | { type: "delete"; rule: MailRule }
        | { type: "order"; ruleIds: string[] }
    ) => {
      if (operation.type === "toggle") {
        return responseJson(
          await route[":ruleId"].$put({
            param: { id: mailboxId, ruleId: operation.rule.id },
            json: { ...ruleInput(operation.rule), enabled: operation.enabled },
          })
        );
      }

      if (operation.type === "delete") {
        return responseJson(
          await route[":ruleId"].$delete({
            param: { id: mailboxId, ruleId: operation.rule.id },
          })
        );
      }

      return responseJson(
        await route.order.$put({
          param: { id: mailboxId },
          json: { ruleIds: operation.ruleIds },
        })
      );
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => client.invalidateQueries({ queryKey }),
  });

  if (editing) {
    return (
      <RuleEditor
        mailboxId={mailboxId}
        folders={customFolders}
        rule={editing === "new" ? null : editing}
        initial={editing === "new" ? emptyRule : ruleInput(editing)}
        onDone={() => setEditing(null)}
      />
    );
  }

  if (rules.isLoading) {
    return (
      <div className="space-y-2 py-2">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }

  if (rules.isError) {
    return (
      <p className="text-muted-foreground border-border/70 border-y py-4 text-sm">
        {rules.error.message}
      </p>
    );
  }

  const list = rules.data ?? [];

  function move(index: number, direction: -1 | 1) {
    const ids = list.map((rule) => rule.id);
    const [moved] = ids.splice(index, 1);

    if (!moved) return;
    ids.splice(index + direction, 0, moved);
    change.mutate({ type: "order", ruleIds: ids });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted-foreground text-xs leading-relaxed">
          Rules run in order on each new message. A matching rule decides the
          folder instead of AI sorting; blocked senders still go to Spam.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setEditing("new")}
        >
          <Plus />
          New rule
        </Button>
      </div>
      <div className="border-border/70 max-h-[min(23rem,50vh)] overflow-y-auto border-y">
        {list.length ? (
          <ol aria-label="Rules">
            {list.map((rule, index) => (
              <li
                key={rule.id}
                className="border-border/60 flex items-start gap-3 border-b px-2 py-2.5 last:border-b-0"
              >
                <Switch
                  className="mt-0.5"
                  checked={rule.enabled}
                  aria-label={`${rule.enabled ? "Turn off" : "Turn on"} ${rule.name}`}
                  disabled={change.isPending}
                  onCheckedChange={(enabled) =>
                    change.mutate({ type: "toggle", rule, enabled })
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{rule.name}</span>
                    {rule.folderDeleted ? (
                      <Badge variant="destructive">Folder deleted</Badge>
                    ) : null}
                    {rule.stopProcessing ? (
                      <Badge variant="outline">stops</Badge>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    If{" "}
                    {rule.conditions
                      .map(describeCondition)
                      .join(rule.match === "all" ? " and " : " or ")}
                    :{" "}
                    {rule.actions
                      .map((action) => describeAction(action, customFolders))
                      .join(", ")}
                    .
                  </p>
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${rule.name} up`}
                    disabled={index === 0 || change.isPending}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${rule.name} down`}
                    disabled={index === list.length - 1 || change.isPending}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${rule.name}`}
                    onClick={() => setEditing(rule)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${rule.name}`}
                    disabled={change.isPending}
                    onClick={() => change.mutate({ type: "delete", rule })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="text-muted-foreground grid min-h-28 place-items-center px-6 text-center text-sm">
            No rules yet. Sort or mark read new mail by sender, recipient,
            subject or mailing list.
          </div>
        )}
      </div>
    </div>
  );
}

/** "Filter messages like this": the rule editor, filled in from a message. */
export function FilterMessagesDialog({
  mailboxId,
  message,
  open,
  onOpenChange,
}: {
  mailboxId: string;
  message: MessageDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const folders = (useFolders(mailboxId).data?.folders ?? []).filter(
    (folder) => folder.kind === "custom"
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Filter messages like this</DialogTitle>
          <DialogDescription>
            A rule for new mail, shared with everyone who can access this
            mailbox.
          </DialogDescription>
        </DialogHeader>
        <RuleEditor
          mailboxId={mailboxId}
          folders={folders}
          rule={null}
          initial={filterDraft(message)}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function RuleEditor({
  mailboxId,
  folders,
  rule,
  initial,
  onDone,
}: {
  mailboxId: string;
  folders: MailFolder[];
  rule: MailRule | null;
  initial: MailRuleInput;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const route = mailApi.api.mail.mailboxes[":id"].rules;
  const [draft, setDraft] = useState(initial);
  // Errors show once the person tried to save or test, then follow edits.
  const [checked, setChecked] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const errors = draftErrors(draft, folders);
  const shown = checked ? errors : null;
  const id = (field: string) => `rule-${mailboxId}-${field}`;

  const save = useMutation({
    mutationFn: async (input: MailRuleInput) =>
      rule
        ? responseJson(
            await route[":ruleId"].$put({
              param: { id: mailboxId, ruleId: rule.id },
              json: input,
            })
          )
        : responseJson(
            await route.$post({ param: { id: mailboxId }, json: input })
          ),
    onSuccess: async () => {
      toast.success(rule ? "Rule updated" : "Rule created");
      await client.invalidateQueries({
        queryKey: ["mailbox-rules", mailboxId],
      });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });

  const test = useMutation({
    mutationFn: async () =>
      responseJson(
        await route.test.$post({
          param: { id: mailboxId },
          json: { match: draft.match, conditions: draft.conditions },
        })
      ),
    onSuccess: (result) =>
      setTestResult(
        `Matches ${result.matches} of the last ${result.scanned} incoming messages.`
      ),
    onError: (error) => setTestResult(error.message),
  });

  const { conditions } = draft;
  const { actions } = draft;

  const setCondition = (index: number, next: Condition) =>
    setDraft({
      ...draft,
      conditions: conditions.map((item, i) => (i === index ? next : item)),
    });

  const setAction = (index: number, next: Action) =>
    setDraft({
      ...draft,
      actions: actions.map((item, i) => (i === index ? next : item)),
    });

  // Each action can appear once in a rule.
  const actionOptions = (current: Action["type"]) =>
    Object.entries(actionLabels).flatMap(([value, label]) => {
      // SAFETY: actionLabels' keys are the action types.
      const type = value as Action["type"];

      return type === current ||
        (!actions.some((action) => action.type === type) &&
          (type !== "moveToFolder" || folders.length))
        ? [[type, label] as const]
        : [];
    });

  const unusedAction = actionOptions("archive").find(
    ([type]) => !actions.some((action) => action.type === type)
  )?.[0];

  function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);

    if (!hasErrors(errors)) save.mutate(draft);
  }

  function runTest() {
    setChecked(true);

    if (!errors.conditions.some(Boolean)) test.mutate();
  }

  return (
    <form className="space-y-4" noValidate onSubmit={submit}>
      <div className="space-y-1.5">
        <Label htmlFor={id("name")}>Name</Label>
        <Input
          id={id("name")}
          maxLength={120}
          placeholder="Receipts to Archive"
          value={draft.name}
          aria-invalid={Boolean(shown?.name) || undefined}
          aria-describedby={shown?.name ? id("name-error") : undefined}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <FieldError id={id("name-error")} error={shown?.name ?? null} />
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 flex items-center gap-2 text-sm">
          When
          <Choice
            label="Match"
            value={draft.match ?? "all"}
            options={
              [
                ["all", "all"],
                ["any", "any"],
              ] as const
            }
            onChange={(match) => setDraft({ ...draft, match })}
          />
          of these are true:
        </legend>
        {conditions.map((condition, index) => {
          const error = shown?.conditions[index] ?? null;
          const errorId = id(`condition-${index}-error`);

          return (
            // Rows have no identity of their own; editing keeps their order.
            // oxlint-disable-next-line react/no-array-index-key -- see above
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Choice
                label="Condition"
                value={condition.type}
                options={Object.entries(conditionLabels).map(
                  ([type, label]) =>
                    // SAFETY: conditionLabels' keys are the condition types.
                    [type as Condition["type"], label] as const
                )}
                onChange={(type) => setCondition(index, defaultCondition(type))}
              />
              {"op" in condition ? (
                <Choice
                  label="Comparison"
                  value={condition.op}
                  options={conditionOps(condition.type).map(
                    (op) => [op, opLabels[op]] as const
                  )}
                  onChange={(op) =>
                    setCondition(
                      index,
                      // SAFETY: the options are conditionOps(condition.type).
                      { ...condition, op } as Condition
                    )
                  }
                />
              ) : null}
              {needsValue(condition) && "value" in condition ? (
                <Input
                  aria-label="Value"
                  className="h-8 min-w-40 flex-1"
                  maxLength={320}
                  placeholder={placeholder(condition)}
                  value={condition.value ?? ""}
                  aria-invalid={Boolean(error) || undefined}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) =>
                    setCondition(index, {
                      ...condition,
                      value: event.target.value,
                    })
                  }
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove condition"
                disabled={conditions.length === 1}
                onClick={() =>
                  setDraft({
                    ...draft,
                    conditions: conditions.filter((_, i) => i !== index),
                  })
                }
              >
                <X />
              </Button>
              <FieldError id={errorId} error={error} />
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={conditions.length >= 10}
          onClick={() =>
            setDraft({
              ...draft,
              conditions: [...conditions, defaultCondition("subject")],
            })
          }
        >
          <Plus />
          Condition
        </Button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm">Then:</legend>
        {actions.map((action, index) => {
          const error = shown?.actions[index] ?? null;
          const errorId = id(`action-${index}-error`);

          return (
            // oxlint-disable-next-line react/no-array-index-key -- rows have no identity of their own
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Choice
                label="Action"
                value={action.type}
                options={actionOptions(action.type)}
                onChange={(type) =>
                  setAction(index, defaultAction(type, folders))
                }
              />
              {action.type === "moveToFolder" ? (
                <Choice
                  label="Folder"
                  value={action.folderId}
                  placeholder="Pick a folder"
                  invalid={Boolean(error)}
                  describedBy={error ? errorId : undefined}
                  options={folders.map(
                    (folder) => [folder.id, folder.name] as const
                  )}
                  onChange={(folderId) =>
                    setAction(index, { ...action, folderId })
                  }
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove action"
                disabled={actions.length === 1}
                onClick={() =>
                  setDraft({
                    ...draft,
                    actions: actions.filter((_, i) => i !== index),
                  })
                }
              >
                <X />
              </Button>
              <FieldError id={errorId} error={error} />
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!unusedAction}
          onClick={() =>
            unusedAction &&
            setDraft({
              ...draft,
              actions: [...actions, defaultAction(unusedAction, folders)],
            })
          }
        >
          <Plus />
          Action
        </Button>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Moving and archiving apply to new conversations, as AI sorting does.
        </p>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={draft.stopProcessing ?? false}
          onCheckedChange={(stopProcessing) =>
            setDraft({ ...draft, stopProcessing })
          }
        />
        Stop running later rules when this one matches
      </label>

      {testResult ? (
        <p className="bg-muted rounded-md px-3 py-2 text-sm" role="status">
          {testResult}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={test.isPending}
          onClick={runTest}
        >
          {test.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <FlaskConical />
          )}
          Test on recent mail
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <LoaderCircle className="animate-spin" /> : null}
          {rule ? "Save rule" : "Create rule"}
        </Button>
      </div>
    </form>
  );
}
