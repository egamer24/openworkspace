import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, ShieldAlert, UserPlus } from "lucide-react";
import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import type { AccessLinkKind } from "../../shared/auth";
import { required } from "../../shared/invariant";
import { userTargetRefusalReason } from "../../shared/workspace";
import { useAuth } from "../auth/auth-context";
import { SectionShell } from "../components/section-shell";
import { Button } from "../components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "../components/ui/input-group";
import { api, responseJson } from "../lib/api";
import { sessionQueryKeys } from "../lib/session-query-keys";
import { clientModules } from "../modules";
import { InviteForm } from "./admin-forms";
import { PeopleList } from "./admin-lists";
import {
  AdminNavigation,
  adminPath,
  useAdminSections,
} from "./admin-navigation";
import type { AdminSection, CoreAdminSection } from "./admin-navigation";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";
import { adminStateQuery } from "./admin-state";
import { Backups } from "./backups";
import { BrandingSettings } from "./branding-settings";
import { ConnectedApps } from "./connected-apps";
import { SsoApps } from "./sso-apps";
import { TeamsManager } from "./teams-manager";
import type {
  AdminOidcProvider,
  AdminPermission,
  AdminSamlProvider,
  AdminUser,
  InvitationInput,
  UpdateUserInput,
} from "./types";
import {
  UserAccessEditor,
  UserPermissionsEditor,
  UserTeamsEditor,
} from "./user-access-editor";
import { UserMailboxes } from "./user-mailboxes";
import { AdminUserSessions } from "./user-sessions";
import { WebhooksManager } from "./webhooks-manager";

type CoreAdminView = CoreAdminSection | "invite" | "user";

/** A core view or a module's section. */
type AdminView = CoreAdminView | (string & {});

type ResourceDetailView = Extract<
  CoreAdminView,
  "sso-applications" | "teams" | "webhooks"
>;

const coreViewCopy: Record<
  CoreAdminView,
  { title: string; description: string }
> = {
  people: {
    title: "People",
    description: "Workspace members, what they may manage, and account access.",
  },
  teams: {
    title: "Teams",
    description:
      "Groups of people, with shared inboxes, mailing lists, and access to apps.",
  },
  "sso-applications": {
    title: "Single sign-on apps",
    description:
      "Apps people sign in to with their account here, over OpenID Connect or SAML.",
  },
  webhooks: {
    title: "Webhooks",
    description: "Signed account events delivered to external systems.",
  },
  "connected-apps": {
    title: "Connected apps",
    description:
      "Apps anyone in the workspace connected to their account: who approved each, and what it may do.",
  },
  branding: {
    title: "Branding",
    description:
      "Your workspace's name and logo, in the app's header and browser tab; the logo is on the sign-in screen too.",
  },
  backups: {
    title: "Backups",
    description:
      "Daily copies of the workspace and each app's data, in a bucket of their own.",
  },
  invite: {
    title: "Invite person",
    description: "Create a personal mailbox and a one-time registration link.",
  },
  user: {
    title: "Person",
    description: "Profile, mailboxes, permissions, and passkey recovery.",
  },
};

const parentViews: Partial<Record<CoreAdminView, CoreAdminView>> = {
  user: "people",
  invite: "people",
};

const resourceDetailCopy: Record<
  ResourceDetailView,
  (creating: boolean) => { title: string; description: string }
> = {
  "sso-applications": (creating) => ({
    title: creating ? "Add an app" : "Single sign-on app",
    description: creating
      ? "Fill in what the app shows on its SSO settings page, then give it this workspace's values."
      : "How the app signs people in, who may, and what it learns about them.",
  }),
  teams: (creating) => ({
    title: creating ? "New team" : "Team",
    description: "Team details, addresses, and members.",
  }),
  webhooks: (creating) => ({
    title: creating ? "New webhook" : "Webhook endpoint",
    description: "Endpoint settings and subscribed events.",
  }),
};

function isCoreAdminView(view: AdminView): view is CoreAdminView {
  return Object.hasOwn(coreViewCopy, view);
}

function viewCopy(view: AdminView) {
  if (isCoreAdminView(view)) return coreViewCopy[view];

  return clientModules()
    .flatMap((module) => module.admin ?? [])
    .find((section) => section.id === view);
}

function isResourceDetailView(view: AdminView): view is ResourceDetailView {
  return Object.hasOwn(resourceDetailCopy, view);
}

/**
 * Administration at /admin/:section, and a record in it at
 * /admin/:section/:id ("new" adds one; people use /admin/people/invite).
 * /admin and sections the person may not open go to their first section.
 */
export function AdminPage() {
  const { section, id } = useParams();
  const sections = useAdminSections();

  if (!section || !sections.some((item) => item.id === section)) {
    const first = sections[0]?.id;

    return <Navigate to={first ? adminPath(first) : "/"} replace />;
  }

  return <AdminSectionPage section={section} recordId={id} />;
}

function AdminSectionPage({
  section,
  recordId,
}: {
  section: AdminSection;
  recordId: string | undefined;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();

  const view: AdminView =
    section === "people" && recordId
      ? recordId === "invite"
        ? "invite"
        : "user"
      : section;

  const selectedId = view === "invite" ? undefined : recordId;

  const [generatedLink, setGeneratedLink] = useState<{
    kind: AccessLinkKind;
    url: string;
    userId?: string;
  }>();

  const [copied, setCopied] = useState(false);

  const state = useQuery(adminStateQuery);
  const auth = useAuth();

  /** The API's rule: administrators act on anyone, others on people no more powerful than themselves. */
  const actor = auth.user;

  const manageable = (user: AdminUser) =>
    actor !== null && userTargetRefusalReason(actor, user) === null;

  const selectedUser = state.data?.users.find((user) => user.id === selectedId);
  const resourceDetail = Boolean(selectedId && isResourceDetailView(view));

  const backView =
    (isCoreAdminView(view) ? parentViews[view] : undefined) ??
    (resourceDetail ? view : undefined);

  // AdminPage only opens sections the person may see, so each has its copy.
  const pageCopy =
    resourceDetail && isResourceDetailView(view)
      ? resourceDetailCopy[view](selectedId === "new")
      : required(viewCopy(view), `Admin section ${view} has no title`);

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

  const updateUser = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateUserInput }) =>
      responseJson(
        await api.api.admin.users[":id"].$patch({ param: { id }, json: input })
      ),
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
        })
      ),
    onSuccess: (result, userId) => {
      setCopied(false);
      setGeneratedLink({ ...result.accessLink, userId });
    },
    onError: (error) => toast.error(error.message),
  });

  function go(next: AdminView, id?: string) {
    setGeneratedLink(undefined);
    setCopied(false);

    if (next === "invite") navigate(adminPath("people", "invite"));
    else if (next === "user") navigate(adminPath("people", id));
    else navigate(adminPath(next, id));
  }

  return (
    <SectionShell
      area="Administration"
      className="max-w-5xl"
      title={pageCopy.title}
      description={pageCopy.description}
      actions={
        backView ? (
          <Button variant="outline" size="sm" onClick={() => go(backView)}>
            <ArrowLeft /> Back to list
          </Button>
        ) : null
      }
      renderNavigation={(onNavigate) => (
        <AdminNavigation
          value={section}
          onNavigate={() => {
            setGeneratedLink(undefined);
            setCopied(false);
            onNavigate?.();
          }}
        />
      )}
    >
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
          <UnlistedDomainsNotice
            domains={state.data?.unlistedMailDomains ?? []}
          />
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
                onInvite={() => go("invite")}
              />
            </div>
          )}
          {view === "sso-applications" && (
            <SsoApps
              oidcClients={state.data?.oidcClients ?? []}
              samlApplications={state.data?.samlApplications ?? []}
              oidcProvider={state.data?.oidcProvider ?? unavailableOidcProvider}
              samlProvider={state.data?.samlProvider ?? unavailableSamlProvider}
              teams={state.data?.teams ?? []}
              loading={state.isLoading}
              selectedId={selectedId}
              onSelect={(id) => go("sso-applications", id)}
            />
          )}
          {view === "teams" && (
            <TeamsManager
              teams={state.data?.teams ?? []}
              users={state.data?.users ?? []}
              mailboxes={state.data?.mailboxes ?? []}
              domains={state.data?.mailDomains ?? []}
              loading={state.isLoading}
              selectedId={selectedId}
              onSelect={(id) => go("teams", id)}
            />
          )}
          {clientModules()
            .flatMap((module) => module.admin ?? [])
            .map(({ id, Component }) =>
              view === id ? <Component key={id} /> : null
            )}
          {view === "webhooks" && (
            <WebhooksManager
              selectedId={selectedId}
              onSelect={(id) => go("webhooks", id)}
            />
          )}
          {view === "connected-apps" && <ConnectedApps />}
          {view === "branding" && <BrandingSettings />}
          {view === "backups" && <Backups />}
          {view === "invite" && (
            <div className="max-w-3xl">
              {state.data ? (
                <InviteForm
                  pending={invite.isPending}
                  domains={state.data.mailDomains}
                  onSubmit={(input) => invite.mutate(input)}
                />
              ) : null}
              {generatedLink?.kind === "invitation" && (
                <AccessLink
                  kind="invitation"
                  url={generatedLink.url}
                  copied={copied}
                  onCopied={() => markCopied(setCopied)}
                />
              )}
            </div>
          )}
          {view === "user" && selectedUser && !manageable(selectedUser) && (
            <div className="max-w-3xl space-y-6">
              <UnmanageablePerson
                user={selectedUser}
                availablePermissions={state.data?.availablePermissions ?? []}
              />
            </div>
          )}
          {view === "user" && selectedUser && manageable(selectedUser) && (
            <div className="max-w-3xl space-y-6">
              <UserAccessEditor
                key={selectedUser.id}
                user={selectedUser}
                pending={updateUser.isPending}
                accessLinkPending={createAccessLink.isPending}
                onCreateAccessLink={() =>
                  createAccessLink.mutate(selectedUser.id)
                }
                onSubmit={(input) =>
                  updateUser.mutate({ id: selectedUser.id, input })
                }
              />
              <UserMailboxes
                key={`mailboxes-${selectedUser.id}`}
                user={selectedUser}
                mailboxes={(state.data?.mailboxes ?? []).filter(
                  (mailbox) => mailbox.ownerUserId === selectedUser.id
                )}
                domains={state.data?.mailDomains ?? []}
              />
              <UserTeamsEditor
                key={`teams-${selectedUser.id}`}
                user={selectedUser}
                teams={state.data?.teams ?? []}
              />
              <UserPermissionsEditor
                key={`permissions-${selectedUser.id}`}
                user={selectedUser}
                availablePermissions={state.data?.availablePermissions ?? []}
              />
              <AdminUserSessions userId={selectedUser.id} />
              {generatedLink?.userId === selectedUser.id && (
                <AccessLink
                  kind={generatedLink.kind}
                  url={generatedLink.url}
                  copied={copied}
                  onCopied={() => markCopied(setCopied)}
                />
              )}
            </div>
          )}
          {view === "user" && state.isSuccess && !selectedUser && (
            <MissingAdminRecord label="Person" onBack={() => go("people")} />
          )}
        </>
      )}
    </SectionShell>
  );
}

const unavailableOidcProvider: AdminOidcProvider = {
  configured: false,
  issuer: null,
  discoveryUrl: null,
  authorizationUrl: null,
  tokenUrl: null,
  userinfoUrl: null,
  jwksUrl: null,
  endSessionUrl: null,
  configurationError: null,
};

const unavailableSamlProvider: AdminSamlProvider = {
  configured: false,
  entityId: null,
  metadataUrl: null,
  ssoUrl: null,
  certificatePem: null,
  certificateFingerprint: null,
  certificateExpiresAt: null,
  configurationError: null,
};

/** A person the signed-in delegate may see but not change, and why. */
function UnmanageablePerson({
  user,
  availablePermissions,
}: {
  user: AdminUser;
  availablePermissions: AdminPermission[];
}) {
  const auth = useAuth();

  const beyond = user.permissions
    .filter((permission) => !auth.user?.permissions.includes(permission))
    .map(
      (permission) =>
        availablePermissions.find((item) => item.id === permission)?.label ??
        permission
    );

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={ShieldAlert}
        title={user.name}
        description={user.personalEmail ?? undefined}
      />
      <AdminPanelBody>
        <p className="text-[0.8125rem] font-semibold">
          Only an administrator can manage this person
        </p>
        <p className="text-muted-foreground mt-1 text-xs leading-5 text-pretty">
          {user.role === "admin"
            ? "They are an administrator. Their account, mailboxes, teams and sessions are managed by other administrators."
            : `They can also ${beyond.map((label) => label.toLocaleLowerCase()).join(", ")}, which you can't. You can only manage people whose permissions you also hold.`}
        </p>
      </AdminPanelBody>
    </div>
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
    <div className="border-border bg-surface rounded-xl border py-16 text-center">
      <p className="text-base font-semibold">{label} not found</p>
      <p className="text-muted-foreground mt-1.5 text-sm">
        It may have been removed or the link is stale.
      </p>
      <Button className="mt-5" variant="outline" size="sm" onClick={onBack}>
        <ArrowLeft /> Back to list
      </Button>
    </div>
  );
}

function AccessLink({
  kind,
  url,
  copied,
  onCopied,
}: {
  kind: AccessLinkKind;
  url: string;
  copied: boolean;
  onCopied: () => void;
}) {
  return (
    <div className="border-primary/25 bg-primary/8 mt-6 rounded-lg border p-4">
      <p className="text-muted-foreground mb-2.5 text-[11px] font-semibold tracking-widest uppercase">
        One-time link — share it over a trusted channel
      </p>
      <InputGroup className="bg-surface h-10">
        <InputGroupAddon>
          <InputGroupText className="font-medium">
            {kind === "invitation" ? "Invitation" : "Recovery"}
          </InputGroupText>
        </InputGroupAddon>
        <InputGroupInput readOnly value={url} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard.writeText(url).then(onCopied)
            }
          >
            {copied ? <Check /> : <Copy />}
            <span className="sr-only">Copy {kind} link</span>
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

/**
 * Addresses on domains that `mailDomains` no longer lists keep working, but
 * no new address can go there; says so until they are moved or deleted.
 */
function UnlistedDomainsNotice({ domains }: { domains: readonly string[] }) {
  if (domains.length === 0) return null;

  return (
    <div
      role="status"
      className="border-destructive/30 bg-destructive/5 mb-4 flex max-w-3xl gap-2 rounded-lg border px-3 py-2.5 text-xs leading-5"
    >
      <ShieldAlert className="text-destructive mt-0.5 size-4 shrink-0" />
      <p className="text-pretty">
        <span className="font-semibold">
          {domains.join(", ")} {domains.length === 1 ? "is" : "are"} no longer
          in mailDomains.
        </span>{" "}
        Addresses there keep working, but no new ones can be created. Add{" "}
        {domains.length === 1 ? "it" : "them"} back in alchemy.run.ts, or delete
        those addresses.
      </p>
    </div>
  );
}
