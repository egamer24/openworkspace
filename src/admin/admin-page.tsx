import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  Inbox,
  MailPlus,
  UserPlus,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { AccessLinkKind } from "../../shared/auth";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, responseJson } from "@/lib/api";
import { sessionQueryKeys } from "@/lib/session-query-keys";
import { InviteForm, MailboxForm } from "./admin-forms";
import { MailboxList, PeopleList } from "./admin-lists";
import {
  AdminNavigation,
  type AdminSection,
  MobileAdminMenu,
} from "./admin-navigation";
import { GlobalAiProcessing } from "./global-ai-processing";
import { MailboxAccessEditor } from "./mailbox-access-editor";
import type {
  CreateMailboxInput,
  InvitationInput,
  UpdateMailboxInput,
  UpdateUserInput,
} from "./types";
import { UserAccessEditor } from "./user-access-editor";
import { GroupsManager } from "./groups-manager";
import { SsoApplications } from "./sso-applications";
import { WebhooksManager } from "./webhooks-manager";
import { DomainsManager } from "./domains-manager";
import { MailRouting } from "./mail-routing";
import { AdminUserSessions } from "./user-sessions";
import { SamlApplications } from "./saml-applications";

type AdminView =
  | "people"
  | "mailboxes"
  | "domains"
  | "addresses"
  | "sso-applications"
  | "saml-applications"
  | "groups"
  | "webhooks"
  | "invite"
  | "new-mailbox"
  | "user"
  | "mailbox";

type ResourceDetailView = Extract<
  AdminView,
  "sso-applications" | "saml-applications" | "groups" | "webhooks"
>;

const viewCopy: Record<AdminView, { title: string; description: string }> = {
  people: { title: "People", description: "Workspace members and their mailbox access." },
  mailboxes: { title: "Mailboxes", description: "Personal and shared addresses provisioned for this workspace." },
  domains: { title: "Domains", description: "Mail domains and Cloudflare zone IDs." },
  addresses: { title: "Addresses", description: "Aliases, forwarding, and unknown-recipient handling." },
  "sso-applications": { title: "OIDC applications", description: "OIDC clients, callbacks, user assignments, and released claims." },
  "saml-applications": { title: "SAML applications", description: "Service providers, assertions, assignments, and attributes." },
  groups: { title: "Identity groups", description: "Reusable memberships exposed to approved identity applications." },
  webhooks: { title: "Webhooks", description: "Signed account events delivered to external systems." },
  invite: { title: "Invite person", description: "Create a personal mailbox and a one-time registration link." },
  "new-mailbox": { title: "New mailbox", description: "Personal or shared address." },
  user: { title: "Person", description: "Profile details and passkey recovery." },
  mailbox: { title: "Mailbox access", description: "Display name and member permissions for this shared address." },
};

const parentViews: Partial<Record<AdminView, AdminView>> = {
  user: "people",
  invite: "people",
  mailbox: "mailboxes",
  "new-mailbox": "mailboxes",
};

const resourceDetailCopy: Record<
  ResourceDetailView,
  (creating: boolean) => { title: string; description: string }
> = {
  "sso-applications": (creating) => ({
    title: creating ? "New OIDC application" : "OIDC application",
    description: "Client settings, access, and released claims.",
  }),
  "saml-applications": (creating) => ({
    title: creating ? "New SAML application" : "SAML application",
    description: "Service provider settings, access, and attributes.",
  }),
  groups: (creating) => ({
    title: creating ? "New identity group" : "Identity group",
    description: "Group details and membership.",
  }),
  webhooks: (creating) => ({
    title: creating ? "New webhook" : "Webhook endpoint",
    description: "Endpoint settings and subscribed events.",
  }),
};

function isResourceDetailView(view: AdminView): view is ResourceDetailView {
  return Object.hasOwn(resourceDetailCopy, view);
}

export function AdminPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const rawView = params.get("view");
  const view: AdminView = rawView && Object.hasOwn(viewCopy, rawView)
    ? rawView as AdminView
    : "people";
  const selectedId = params.get("id") ?? undefined;
  const [generatedLink, setGeneratedLink] = useState<{
    kind: AccessLinkKind;
    url: string;
    userId?: string;
  }>();
  const [copied, setCopied] = useState(false);

  const state = useQuery({
    queryKey: ["admin-state"],
    queryFn: async () => responseJson(await api.api.admin.state.$get()),
  });
  const sharedMailboxes = state.data?.mailboxes.filter((mailbox) => mailbox.kind === "shared") ?? [];
  const selectedUser = state.data?.users.find((user) => user.id === selectedId);
  const selectedMailbox = sharedMailboxes.find((mailbox) => mailbox.id === selectedId);
  const activeSection: AdminSection = view === "user" || view === "invite"
    ? "people"
    : view === "mailbox" || view === "new-mailbox"
      ? "mailboxes"
      : view;
  const resourceDetail = Boolean(selectedId && isResourceDetailView(view));
  const backView = parentViews[view] ?? (resourceDetail ? view : undefined);
  const pageCopy = resourceDetail && isResourceDetailView(view)
    ? resourceDetailCopy[view](selectedId === "new")
    : viewCopy[view];

  const invite = useMutation({
    mutationFn: async (input: InvitationInput) =>
      responseJson(await api.api.admin.invitations.$post({ json: input })),
    onSuccess: async (result) => {
      setCopied(false);
      setGeneratedLink(result.accessLink);
      await invalidateAdminData(client);
    },
    onError: (error) => toast.error(error.message),
  });
  const createMailbox = useMutation({
    mutationFn: async (input: CreateMailboxInput) => responseJson(await api.api.admin.mailboxes.$post({ json: input })),
    onSuccess: async () => {
      toast.success("Mailbox created");
      await invalidateAdminData(client);
      go("mailboxes");
    },
    onError: (error) => toast.error(error.message),
  });
  const setPrimaryMailbox = useMutation({
    mutationFn: async (id: string) => responseJson(
      await api.api.admin.mailboxes[":id"].primary.$post({ param: { id } }),
    ),
    onSuccess: async () => {
      toast.success("Primary mailbox updated");
      await invalidateAdminData(client);
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteMailbox = useMutation({
    mutationFn: async (id: string) => responseJson(
      await api.api.admin.mailboxes[":id"].$delete({ param: { id } }),
    ),
    onSuccess: async () => {
      toast.success("Mailbox deleted");
      await invalidateAdminData(client);
    },
    onError: (error) => toast.error(error.message),
  });
  const updateMailbox = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateMailboxInput }) => responseJson(await api.api.admin.mailboxes[":id"].$patch({ param: { id }, json: input })),
    onSuccess: async () => {
      toast.success("Mailbox access updated");
      await invalidateAdminData(client);
    },
    onError: (error) => toast.error(error.message),
  });
  const updateUser = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateUserInput }) => responseJson(await api.api.admin.users[":id"].$patch({ param: { id }, json: input })),
    onSuccess: async (_result, { id }) => {
      toast.success("User access updated");
      await Promise.all([
        invalidateAdminData(client),
        client.invalidateQueries({ queryKey: sessionQueryKeys.adminUser(id) }),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const createAccessLink = useMutation({
    mutationFn: async (userId: string) =>
      responseJson(
        await api.api.admin.users[":id"]["access-link"].$post({
          param: { id: userId },
        }),
      ),
    onSuccess: (result, userId) => {
      setCopied(false);
      setGeneratedLink({ ...result.accessLink, userId });
    },
    onError: (error) => toast.error(error.message),
  });

  function go(next: AdminView, id?: string) {
    const nextParams = new URLSearchParams();
    nextParams.set("view", next);
    if (id) nextParams.set("id", id);
    setGeneratedLink(undefined);
    setCopied(false);
    setParams(nextParams);
  }

  return (
    <main className="flex h-dvh min-h-0 bg-background">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Inbox className="size-4.5" strokeWidth={2.25} />
          </span>
          <div>
            <p className="text-[0.875rem] leading-tight font-semibold tracking-[-0.01em]">OpenWorkspace</p>
            <p className="text-[11px] leading-tight text-muted-foreground">Administration</p>
          </div>
        </div>
        <AdminNavigation value={activeSection} onChange={(value) => go(value)} />
        <div className="mt-auto border-t border-border/70 p-3">
          <Button className="w-full justify-start" variant="ghost" onClick={() => navigate("/")}>
            <ArrowLeft /> Back to mail
          </Button>
        </div>
      </aside>

      <section className="paper-grain flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6 lg:px-8">
          <MobileAdminMenu
            value={activeSection}
            onChange={(value) => go(value)}
            onBack={() => navigate("/")}
          />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-[-0.02em]">{pageCopy.title}</h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">{pageCopy.description}</p>
          </div>
          {backView && (
            <Button className="ml-auto" variant="outline" size="sm" onClick={() => go(backView)}>
              <ArrowLeft /> Back to list
            </Button>
          )}
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
            {state.isError ? (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
                <p className="text-base font-semibold tracking-[-0.01em]">
                  Administration unavailable
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.isFetching}
                  onClick={() => void state.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <>
                {view === "people" && (
                  <div className="max-w-3xl space-y-3">
                    <div className="flex justify-end">
                      <Button size="sm" onClick={() => go("invite")}>
                        <UserPlus /> Invite person
                      </Button>
                    </div>
                    <PeopleList
                      users={state.data?.users}
                      loading={state.isLoading}
                      onManage={(id) => go("user", id)}
                    />
                  </div>
                )}
            {view === "mailboxes" && (
              <div className="max-w-3xl space-y-6">
                <GlobalAiProcessing
                  enabled={state.data?.aiProcessingEnabled ?? false}
                  loading={state.isLoading}
                />
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => go("new-mailbox")}>
                      <MailPlus /> New mailbox
                    </Button>
                  </div>
                  <MailboxList
                    mailboxes={state.data?.mailboxes}
                    loading={state.isLoading}
                    onManage={(id) => go("mailbox", id)}
                    onMakePrimary={(id) => setPrimaryMailbox.mutate(id)}
                    onDelete={(id) => deleteMailbox.mutate(id)}
                    pending={setPrimaryMailbox.isPending || deleteMailbox.isPending}
                  />
                </div>
              </div>
            )}
            {view === "domains" && (
              <div className="max-w-3xl">
                <DomainsManager
                  domains={state.data?.domains ?? []}
                  loading={state.isLoading}
                  cloudflareOnboarding={state.data?.cloudflareOnboarding ?? false}
                />
              </div>
            )}
            {view === "addresses" && (
              <div className="max-w-3xl">
                <MailRouting mailboxes={state.data?.mailboxes ?? []} />
              </div>
            )}
            {view === "sso-applications" && (
              <SsoApplications
                clients={state.data?.oidcClients ?? []}
                users={state.data?.users ?? []}
                groups={state.data?.groups ?? []}
                loading={state.isLoading}
                selectedId={selectedId}
                onSelect={(id) => go("sso-applications", id)}
              />
            )}
            {view === "saml-applications" && (
              <SamlApplications
                applications={state.data?.samlApplications ?? []}
                provider={state.data?.samlProvider ?? {
                  configured: false,
                  entityId: null,
                  metadataUrl: null,
                  ssoUrl: null,
                  configurationError: null,
                }}
                users={state.data?.users ?? []}
                groups={state.data?.groups ?? []}
                loading={state.isLoading}
                selectedId={selectedId}
                onSelect={(id) => go("saml-applications", id)}
              />
            )}
            {view === "groups" && (
              <GroupsManager
                groups={state.data?.groups ?? []}
                users={state.data?.users ?? []}
                loading={state.isLoading}
                selectedId={selectedId}
                onSelect={(id) => go("groups", id)}
              />
            )}
            {view === "webhooks" && (
              <WebhooksManager
                selectedId={selectedId}
                onSelect={(id) => go("webhooks", id)}
              />
            )}
            {view === "invite" && (
              <div className="max-w-3xl">
                {state.data?.domains.length ? (
                  <InviteForm
                    pending={invite.isPending}
                    domains={state.data.domains}
                    onSubmit={(input) => invite.mutate(input)}
                  />
                ) : null}
                {generatedLink?.kind === "invitation" && <AccessLink kind="invitation" url={generatedLink.url} copied={copied} onCopied={() => markCopied(setCopied)} />}
              </div>
            )}
            {view === "new-mailbox" && (
              <div className="max-w-3xl">
                {state.data?.domains.length ? (
                  <MailboxForm
                    pending={createMailbox.isPending}
                    domains={state.data.domains}
                    users={state.data?.users ?? []}
                    onSubmit={(input) => createMailbox.mutate(input)}
                  />
                ) : null}
              </div>
            )}
            {view === "user" && selectedUser && (
              <div className="max-w-3xl space-y-6">
                <UserAccessEditor
                  key={selectedUser.id}
                  user={selectedUser}
                  pending={updateUser.isPending}
                  accessLinkPending={createAccessLink.isPending}
                  onCreateAccessLink={() => createAccessLink.mutate(selectedUser.id)}
                  onSubmit={(input) => updateUser.mutate({ id: selectedUser.id, input })}
                />
                <AdminUserSessions userId={selectedUser.id} />
                {generatedLink?.userId === selectedUser.id && (
                  <AccessLink kind={generatedLink.kind} url={generatedLink.url} copied={copied} onCopied={() => markCopied(setCopied)} />
                )}
              </div>
            )}
            {view === "mailbox" && selectedMailbox && (
              <div className="max-w-3xl">
                <MailboxAccessEditor
                  key={selectedMailbox.id}
                  mailbox={selectedMailbox}
                  users={state.data?.users ?? []}
                  pending={updateMailbox.isPending}
                  onSubmit={(input) => updateMailbox.mutate({ id: selectedMailbox.id, input })}
                />
              </div>
            )}
            {view === "user" && state.isSuccess && !selectedUser && (
              <MissingAdminRecord
                label="Person"
                onBack={() => go("people")}
              />
            )}
            {view === "mailbox" && state.isSuccess && !selectedMailbox && (
              <MissingAdminRecord
                label="Mailbox"
                onBack={() => go("mailboxes")}
              />
            )}
              </>
            )}
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}

function MissingAdminRecord({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface py-16 text-center">
      <p className="text-base font-semibold">{label} not found</p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        It may have been removed or the link is stale.
      </p>
      <Button className="mt-5" variant="outline" size="sm" onClick={onBack}>
        <ArrowLeft /> Back to list
      </Button>
    </div>
  );
}

function AccessLink({ kind, url, copied, onCopied }: { kind: AccessLinkKind; url: string; copied: boolean; onCopied: () => void }) {
  return (
    <div className="mt-6 rounded-lg border border-primary/25 bg-primary/8 p-4">
      <p className="mb-2.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
        One-time link — share it over a trusted channel
      </p>
      <InputGroup className="h-10 bg-surface">
        <InputGroupAddon><InputGroupText className="font-medium">{kind === "invitation" ? "Invitation" : "Recovery"}</InputGroupText></InputGroupAddon>
        <InputGroupInput readOnly value={url} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-sm" variant="outline" onClick={() => void navigator.clipboard.writeText(url).then(onCopied)}>
            {copied ? <Check /> : <Copy />}<span className="sr-only">Copy {kind} link</span>
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function markCopied(setCopied: (value: boolean) => void) {
  setCopied(true);
  setTimeout(() => setCopied(false), 1500);
}

async function invalidateAdminData(client: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["admin-state"] }),
    client.invalidateQueries({ queryKey: ["mailboxes"] }),
  ]);
}
