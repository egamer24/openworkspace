import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Filter,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, responseJson, type SuccessfulResponse } from "@/lib/api";
import type { Mailbox } from "@/mail/types";
import { useFolders, useMailboxes } from "@/mail/use-mail-data";

type RulesRoute = (typeof api.api.mail.mailboxes)[":id"]["rules"];
type Rule = SuccessfulResponse<Awaited<ReturnType<RulesRoute["$get"]>>>["rules"][number];
type RuleInput = Parameters<RulesRoute["$post"]>[0]["json"];
type Condition = RuleInput["conditions"][number];
type Action = RuleInput["actions"][number];
type Folder = { id: string; name: string };

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
  spam: "Mark as spam",
  notSpam: "Never send to Spam",
  markRead: "Mark as read",
  forward: "Forward to",
};

function defaultCondition(type: Condition["type"]): Condition {
  switch (type) {
    case "from": return { type, op: "contains", value: "" };
    case "recipient": return { type, op: "contains", value: "" };
    case "subject": return { type, op: "contains", value: "" };
    case "listId": return { type, op: "exists" };
    case "hasAttachment": return { type };
  }
}

function defaultAction(type: Action["type"], folders: Folder[]): Action {
  switch (type) {
    case "moveToFolder": return { type, folderId: folders[0]?.id ?? "" };
    case "forward": return { type, to: "", keepCopy: true };
    default: return { type };
  }
}

function describeCondition(condition: Condition) {
  if (condition.type === "hasAttachment") return "has an attachment";
  if (condition.type === "listId") {
    return condition.op === "exists" ? "is from a mailing list" : `list contains “${condition.value}”`;
  }
  const verb = condition.op === "domain" ? "is from domain" : condition.op === "equals" ? "is" : "contains";
  return `${conditionLabels[condition.type].toLowerCase()} ${verb} “${condition.value}”`;
}

function describeAction(action: Action, folders: Folder[]) {
  if (action.type === "moveToFolder") {
    return `move to ${folders.find((folder) => folder.id === action.folderId)?.name ?? "a folder"}`;
  }
  if (action.type === "forward") return `forward to ${action.to}${action.keepCopy ? "" : " (no copy kept)"}`;
  return actionLabels[action.type].toLowerCase();
}

const emptyRule: RuleInput = {
  name: "",
  enabled: true,
  match: "all",
  conditions: [{ type: "from", op: "contains", value: "" }],
  actions: [{ type: "archive" }],
  stopProcessing: false,
};

function RuleEditor({
  mailbox,
  folders,
  rule,
  onClose,
}: {
  mailbox: Mailbox;
  folders: Folder[];
  rule: Rule | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<RuleInput>(() => rule
    ? {
        name: rule.name,
        enabled: rule.enabled,
        match: rule.match,
        conditions: rule.conditions,
        actions: rule.actions,
        stopProcessing: rule.stopProcessing,
      }
    : emptyRule);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const route = api.api.mail.mailboxes[":id"].rules;

  const setCondition = (index: number, next: Condition) =>
    setDraft({ ...draft, conditions: draft.conditions.map((item, i) => i === index ? next : item) });
  const setAction = (index: number, next: Action) =>
    setDraft({ ...draft, actions: draft.actions.map((item, i) => i === index ? next : item) });

  async function test() {
    try {
      const result = await responseJson(await route.test.$post({
        param: { id: mailbox.id },
        json: { match: draft.match, conditions: draft.conditions },
      }));
      setTestResult(`Matches ${result.matches} of the last ${result.scanned} incoming messages.`);
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : "Could not test this rule");
    }
  }

  async function save() {
    setSaving(true);
    try {
      if (rule) {
        await responseJson(await route[":ruleId"].$put({ param: { id: mailbox.id, ruleId: rule.id }, json: draft }));
      } else {
        await responseJson(await route.$post({ param: { id: mailbox.id }, json: draft }));
      }
      await client.invalidateQueries({ queryKey: ["rules", mailbox.id] });
      toast.success(rule ? "Rule updated" : "Rule created");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Rule could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>Runs on new mail to {mailbox.address}, after spam filtering.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input id="rule-name" value={draft.name} maxLength={120} placeholder="Receipts to Archive"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              When
              <Select value={draft.match} onValueChange={(value) => setDraft({ ...draft, match: value as "all" | "any" })}>
                <SelectTrigger size="sm"><SelectValue>{draft.match === "all" ? "all" : "any"}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all</SelectItem>
                  <SelectItem value="any">any</SelectItem>
                </SelectContent>
              </Select>
              of these are true:
            </div>
            {draft.conditions.map((condition, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Select value={condition.type} onValueChange={(value) => setCondition(index, defaultCondition(value as Condition["type"]))}>
                  <SelectTrigger size="sm" className="w-36"><SelectValue>{conditionLabels[condition.type]}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {Object.entries(conditionLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {"op" in condition ? (
                  <Select value={condition.op} onValueChange={(value) => setCondition(index, { ...condition, op: value } as Condition)}>
                    <SelectTrigger size="sm" className="w-32"><SelectValue>{condition.op === "domain" ? "domain is" : condition.op}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {(condition.type === "from" ? ["contains", "equals", "domain"]
                        : condition.type === "listId" ? ["exists", "contains"] : ["contains", "equals"]).map((op) => (
                        <SelectItem key={op} value={op}>{op === "domain" ? "domain is" : op}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {"op" in condition && condition.op !== "exists" ? (
                  <Input className="h-8 min-w-40 flex-1" value={"value" in condition ? condition.value ?? "" : ""}
                    placeholder={condition.op === "domain" ? "example.com" : "text"}
                    onChange={(event) => setCondition(index, { ...condition, value: event.target.value } as Condition)} />
                ) : null}
                <Button type="button" variant="ghost" size="icon-sm" disabled={draft.conditions.length === 1}
                  onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })}>
                  <X /><span className="sr-only">Remove condition</span>
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={draft.conditions.length >= 10}
              onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, defaultCondition("subject")] })}>
              <Plus /> Condition
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-sm">Then:</p>
            {draft.actions.map((action, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Select value={action.type} onValueChange={(value) => setAction(index, defaultAction(value as Action["type"], folders))}>
                  <SelectTrigger size="sm" className="w-44"><SelectValue>{actionLabels[action.type]}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {Object.entries(actionLabels)
                      .filter(([value]) => value !== "moveToFolder" || folders.length)
                      .map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {action.type === "moveToFolder" ? (
                  <Select value={action.folderId} onValueChange={(value) => setAction(index, { ...action, folderId: String(value) })}>
                    <SelectTrigger size="sm" className="w-40">
                      <SelectValue>{folders.find((folder) => folder.id === action.folderId)?.name ?? "Folder"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {folders.map((folder) => <SelectItem key={folder.id} value={folder.id}>{folder.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : null}
                {action.type === "forward" ? (
                  <>
                    <Input className="h-8 min-w-48 flex-1" type="email" value={action.to} placeholder="someone@example.com"
                      onChange={(event) => setAction(index, { ...action, to: event.target.value })} />
                    <label className="flex items-center gap-2 text-xs">
                      <Switch checked={action.keepCopy} onCheckedChange={(keepCopy) => setAction(index, { ...action, keepCopy })} />
                      Keep a copy
                    </label>
                  </>
                ) : null}
                <Button type="button" variant="ghost" size="icon-sm" disabled={draft.actions.length === 1}
                  onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, i) => i !== index) })}>
                  <X /><span className="sr-only">Remove action</span>
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={draft.actions.length >= 10}
              onClick={() => setDraft({ ...draft, actions: [...draft.actions, defaultAction("markRead", folders)] })}>
              <Plus /> Action
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Forwards are sent from {mailbox.address} with Reply-To set to the original sender. Spam and mail that was already forwarded three times are never forwarded.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.stopProcessing} onCheckedChange={(stopProcessing) => setDraft({ ...draft, stopProcessing })} />
            Stop running later rules when this one matches
          </label>

          {testResult ? <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm">{testResult}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void test()}>Test on recent mail</Button>
          <Button type="button" disabled={saving || !draft.name.trim()} onClick={() => void save()}>
            {saving ? <LoaderCircle className="animate-spin" /> : null}
            {rule ? "Save rule" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MailboxRules({ mailbox }: { mailbox: Mailbox }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const folders = (useFolders(mailbox.id).data?.folders ?? []).filter((folder) => folder.kind === "custom");
  const rules = useQuery({
    queryKey: ["rules", mailbox.id],
    queryFn: async ({ signal }) => (await responseJson(
      await api.api.mail.mailboxes[":id"].rules.$get({ param: { id: mailbox.id } }, { init: { signal } }),
    )).rules,
  });
  const route = api.api.mail.mailboxes[":id"].rules;
  const refresh = () => client.invalidateQueries({ queryKey: ["rules", mailbox.id] });

  async function run(task: () => Promise<unknown>, failure: string) {
    try {
      await task();
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failure);
    }
  }

  const list = rules.data ?? [];
  return (
    <div className="space-y-3 py-5 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs font-medium">{mailbox.address}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing("new")}><Plus /> New rule</Button>
      </div>
      {rules.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Loading rules…</p>
      ) : !list.length ? (
        <p className="text-sm text-muted-foreground">No rules yet.</p>
      ) : (
        <ol className="divide-y divide-border/70 rounded-lg border border-border">
          {list.map((rule, index) => (
            <li key={rule.id} className="flex items-start gap-3 px-3 py-2.5">
              <Switch
                className="mt-0.5"
                checked={rule.enabled}
                aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                onCheckedChange={(enabled) => void run(async () => responseJson(await route[":ruleId"].$put({
                  param: { id: mailbox.id, ruleId: rule.id },
                  json: { name: rule.name, enabled, match: rule.match, conditions: rule.conditions, actions: rule.actions, stopProcessing: rule.stopProcessing },
                })), "Rule could not be updated")}
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {rule.name}
                  {rule.stopProcessing ? <Badge variant="outline">stops</Badge> : null}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  If {rule.conditions.map(describeCondition).join(rule.match === "all" ? " and " : " or ")},{" "}
                  {rule.actions.map((action) => describeAction(action, folders)).join(", ")}.
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0}
                  onClick={() => void run(async () => {
                    const ids = list.map((item) => item.id);
                    [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                    return responseJson(await route.order.$put({ param: { id: mailbox.id }, json: { ruleIds: ids } }));
                  }, "Rules could not be reordered")}>
                  <ArrowUp /><span className="sr-only">Move up</span>
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" disabled={index === list.length - 1}
                  onClick={() => void run(async () => {
                    const ids = list.map((item) => item.id);
                    [ids[index + 1], ids[index]] = [ids[index]!, ids[index + 1]!];
                    return responseJson(await route.order.$put({ param: { id: mailbox.id }, json: { ruleIds: ids } }));
                  }, "Rules could not be reordered")}>
                  <ArrowDown /><span className="sr-only">Move down</span>
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(rule)}>
                  <Pencil /><span className="sr-only">Edit {rule.name}</span>
                </Button>
                <Button type="button" variant="ghost" size="icon-sm"
                  onClick={() => void run(async () => responseJson(await route[":ruleId"].$delete({
                    param: { id: mailbox.id, ruleId: rule.id },
                  })), "Rule could not be deleted")}>
                  <Trash2 /><span className="sr-only">Delete {rule.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {editing ? (
        <RuleEditor
          mailbox={mailbox}
          folders={folders}
          rule={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

export function RuleSettings() {
  const mailboxes = useMailboxes();
  const sendable = mailboxes.data?.mailboxes.filter((mailbox) => mailbox.canSend) ?? [];
  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Filter}
        title="Rules"
        description="Sort, mark read or forward new mail automatically. Rules run in order on each new message."
      />
      <AdminPanelBody className="divide-y divide-border/70">
        {mailboxes.isLoading ? (
          <p className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Loading mailboxes…</p>
        ) : sendable.length ? (
          sendable.map((mailbox) => <MailboxRules key={mailbox.id} mailbox={mailbox} />)
        ) : (
          <p className="py-4 text-sm text-muted-foreground">You don't have send access to any mailbox.</p>
        )}
      </AdminPanelBody>
    </div>
  );
}
