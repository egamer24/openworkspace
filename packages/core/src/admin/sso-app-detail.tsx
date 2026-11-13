import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileKey2,
  LoaderCircle,
  RotateCw,
  Save,
  Shield,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { useConfirm } from "../hooks/use-confirm";
import { api, responseJson } from "../lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import { AppProvisioning } from "./app-provisioning";
import { SamlAdvancedFields, SamlConnectionFields } from "./saml-app-fields";
import {
  Field,
  OidcAdvancedFields,
  OidcRedirectField,
  OidcScopesField,
  WhoCanSignIn,
} from "./sso-app-fields";
import {
  oidcAppFromClient,
  oidcPayload,
  oidcSaveProblems,
  samlAppFromApplication,
  samlPayload,
  samlSaveProblems,
  testSignIn,
} from "./sso-app-model";
import type { OidcAppInput, SamlAppInput } from "./sso-app-model";
import { SaveProblems, TestSignInPanel } from "./sso-app-wizard";
import {
  OidcProviderDetails,
  SamlProviderDetails,
} from "./sso-provider-details";
import type {
  AdminOidcClient,
  AdminOidcProvider,
  AdminSamlApplicationDetails,
  AdminSamlProvider,
  AdminTeam,
} from "./types";

const tabSchema = z.enum(["overview", "access", "provisioning", "advanced"]);

type Tab = z.infer<typeof tabSchema>;

const tabLabels: Record<Tab, string> = {
  overview: "Overview",
  access: "Access",
  provisioning: "Provisioning",
  advanced: "Advanced",
};

async function refreshAdmin(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: ["admin-state"] });
}

function DetailHeader({
  protocol,
  name,
  managed,
  enabled,
  togglePending,
  onToggle,
}: {
  protocol: "oidc" | "saml";
  name: string;
  managed: boolean;
  enabled: boolean;
  togglePending: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div
      className={`${adminPanelClass} flex flex-wrap items-center gap-3 px-5 py-4`}
    >
      <span className="bg-primary/12 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
        {protocol === "oidc" ? (
          <Shield className="size-4" />
        ) : (
          <FileKey2 className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-lg font-semibold tracking-[-0.02em]">
          {name}
        </h2>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge variant="outline">
            {protocol === "oidc" ? "OIDC" : "SAML"}
          </Badge>
          {managed ? <Badge variant="info">Managed by deployment</Badge> : null}
        </div>
      </div>
      <label className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs font-medium">
        {enabled ? "Sign-in on" : "Sign-in off"}
        <Switch
          checked={enabled}
          disabled={managed || togglePending}
          onCheckedChange={onToggle}
          aria-label="Allow sign-in to this app"
        />
      </label>
    </div>
  );
}

function ManagedNote() {
  return (
    <p className="bg-info/10 ring-info/25 rounded-lg px-4 py-3 text-xs leading-5 ring-1">
      This app is declared in the deployment (alchemy.run.ts) and is read-only
      here. Change it there and deploy again.
    </p>
  );
}

function DetailTabs({
  tab,
  onTab,
  managed,
  footer,
  children,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  managed: boolean;
  footer: ReactNode;
  children: Record<Tab, ReactNode>;
}) {
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        const parsed = tabSchema.safeParse(next);

        if (parsed.success) onTab(parsed.data);
      }}
      className="gap-4"
    >
      <TabsList>
        {tabSchema.options.map((value) => (
          <TabsTrigger key={value} value={value}>
            {tabLabels[value]}
          </TabsTrigger>
        ))}
      </TabsList>
      {managed ? <ManagedNote /> : null}
      {tabSchema.options.map((value) => (
        <TabsContent key={value} value={value} className="space-y-5">
          {children[value]}
        </TabsContent>
      ))}
      {tab !== "provisioning" && !managed ? footer : null}
    </Tabs>
  );
}

function SaveBar({
  problems,
  dirty,
  pending,
  onSave,
}: {
  problems: string[];
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
}) {
  const reasons = problems.length
    ? problems
    : dirty
      ? []
      : ["make a change first"];

  return (
    <div
      className={`${adminPanelClass} flex flex-wrap items-center justify-end gap-3 px-5 py-3.5`}
    >
      <SaveProblems problems={reasons} prefix="To save" />
      <Button disabled={reasons.length > 0 || pending} onClick={onSave}>
        {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
        Save changes
      </Button>
    </div>
  );
}

function Section({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className={adminPanelClass}>
      <AdminPanelHeader title={title} description={description} />
      <AdminPanelBody className="space-y-5">{children}</AdminPanelBody>
      {footer ? (
        <AdminPanelFooter className="justify-between">
          {footer}
        </AdminPanelFooter>
      ) : null}
    </section>
  );
}

export function OidcAppDetail({
  client,
  provider,
  teams,
  secret,
  onSecret,
  onDeleted,
}: {
  client: AdminOidcClient;
  provider: AdminOidcProvider;
  teams: AdminTeam[];
  secret?: string;
  onSecret: (value: string) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const saved = oidcAppFromClient(client);
  const [input, setInput] = useState(saved);
  const [tab, setTab] = useState<Tab>("overview");
  const managed = client.managedBy === "deployment";

  const update = (patch: Partial<OidcAppInput>) => {
    if (!managed) setInput((current) => ({ ...current, ...patch }));
  };

  const dirty =
    JSON.stringify(oidcPayload(input)) !== JSON.stringify(oidcPayload(saved));

  const patch = async (value: OidcAppInput) =>
    responseJson(
      await api.api.admin["oidc-clients"][":id"].$patch({
        param: { id: client.id },
        json: oidcPayload(value),
      })
    );

  const save = useMutation({
    mutationFn: () => patch(input),
    onSuccess: async () => {
      toast.success("Changes saved");
      await refreshAdmin(queryClient);
    },
    onError: (error) => toast.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch({ ...saved, enabled }),
    onSuccess: async (_result, enabled) => {
      setInput((current) => ({ ...current, enabled }));
      toast.success(enabled ? "Sign-in turned on" : "Sign-in turned off");
      await refreshAdmin(queryClient);
    },
    onError: (error) => toast.error(error.message),
  });

  const rotate = useMutation({
    mutationFn: async () =>
      responseJson(
        await api.api.admin["oidc-clients"][":id"]["rotate-secret"].$post({
          param: { id: client.id },
        })
      ),
    onSuccess: (result) => {
      onSecret(result.clientSecret);
      toast.success("New client secret created. Update it in the app.");
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async () =>
      responseJson(
        await api.api.admin["oidc-clients"][":id"].$delete({
          param: { id: client.id },
        })
      ),
    onSuccess: async () => {
      toast.success(`${client.name} removed`);
      await refreshAdmin(queryClient);
      onDeleted();
    },
    onError: (error) => toast.error(error.message),
  });

  const test = testSignIn({ appUrl: client.redirectUris[0] ?? "" });
  const { confirm, dialog: confirmDialog } = useConfirm();

  return (
    <div className="max-w-3xl space-y-5">
      {confirmDialog}
      <DetailHeader
        protocol="oidc"
        name={client.name}
        managed={managed}
        enabled={client.enabled}
        togglePending={toggle.isPending}
        onToggle={(enabled) => toggle.mutate(enabled)}
      />
      <DetailTabs
        tab={tab}
        onTab={setTab}
        managed={managed}
        footer={
          <SaveBar
            problems={oidcSaveProblems(input)}
            dirty={dirty}
            pending={save.isPending}
            onSave={() => save.mutate()}
          />
        }
      >
        {{
          overview: (
            <>
              <OidcProviderDetails
                provider={provider}
                clientId={client.id}
                clientSecret={secret}
                clientType={client.clientType}
              >
                {client.clientType === "confidential" && !managed ? (
                  <div className="flex flex-wrap items-center gap-3 py-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={rotate.isPending}
                      onClick={async () => {
                        const confirmed = await confirm({
                          title: "Create a new client secret?",
                          description: `The old secret stops working at once, so ${client.name} cannot sign people in until it has the new one.`,
                          action: "Create new secret",
                          destructive: true,
                        });

                        if (confirmed) rotate.mutate();
                      }}
                    >
                      {rotate.isPending ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <RotateCw />
                      )}
                      New client secret
                    </Button>
                    <span className="text-muted-foreground text-[11px]">
                      For when the old one was lost or leaked.
                    </span>
                  </div>
                ) : null}
              </OidcProviderDetails>
              <Section
                title="Sign-in"
                description="The app's name and where it receives people after sign-in."
              >
                <Field id="oidc-detail-name" label="Name">
                  <Input
                    id="oidc-detail-name"
                    value={input.name}
                    disabled={managed}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </Field>
                <OidcRedirectField
                  id="oidc-detail-redirect"
                  value={input.redirectUri}
                  disabled={managed}
                  onChange={(redirectUri) => update({ redirectUri })}
                />
                <TestSignInPanel
                  test={client.enabled ? test : null}
                  appLabel={client.name}
                />
                {client.enabled ? null : (
                  <p className="text-muted-foreground text-xs">
                    Turn sign-in on above to test it.
                  </p>
                )}
              </Section>
              {managed ? null : (
                <DeleteApp
                  name={client.name}
                  pending={remove.isPending}
                  onDelete={() => remove.mutate()}
                />
              )}
            </>
          ),
          access: (
            <Section
              title="Access"
              description="Who may sign in to the app, and what it learns about their teams."
            >
              <OidcScopesField
                value={input.allowedScopes}
                disabled={managed}
                onChange={(allowedScopes) => update({ allowedScopes })}
              />
              <WhoCanSignIn
                teams={teams}
                value={input.accessTeams}
                sendTeams={input.allowedScopes.includes("groups")}
                readOnly={managed}
                onChange={(accessTeams) => update({ accessTeams })}
              />
            </Section>
          ),
          provisioning: (
            <AppProvisioning
              key={`provisioning-${client.id}`}
              kind="oidc-clients"
              applicationId={client.id}
              provisioning={client.provisioning}
              managed={managed}
            />
          ),
          advanced: (
            <Section
              title="Advanced"
              description="Only if the app's instructions mention these."
            >
              <OidcAdvancedFields
                input={input}
                creating={false}
                disabled={managed}
                onChange={update}
              />
            </Section>
          ),
        }}
      </DetailTabs>
    </div>
  );
}

export function SamlAppDetail({
  application,
  provider,
  teams,
  onDeleted,
}: {
  application: AdminSamlApplicationDetails;
  provider: AdminSamlProvider;
  teams: AdminTeam[];
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const saved = samlAppFromApplication(application);
  const [input, setInput] = useState(saved);
  const [tab, setTab] = useState<Tab>("overview");
  const managed = application.managedBy === "deployment";

  const update = (patch: Partial<SamlAppInput>) => {
    if (!managed) setInput((current) => ({ ...current, ...patch }));
  };

  const dirty =
    JSON.stringify(samlPayload(input)) !== JSON.stringify(samlPayload(saved));

  async function refresh() {
    await Promise.all([
      refreshAdmin(queryClient),
      queryClient.invalidateQueries({
        queryKey: ["saml-application", application.id],
      }),
    ]);
  }

  const patch = async (value: SamlAppInput) =>
    responseJson(
      await api.api.admin["saml-applications"][":id"].$patch({
        param: { id: application.id },
        json: samlPayload(value),
      })
    );

  const save = useMutation({
    mutationFn: () => patch(input),
    onSuccess: async () => {
      toast.success("Changes saved");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch({ ...saved, enabled }),
    onSuccess: async (_result, enabled) => {
      setInput((current) => ({ ...current, enabled }));
      toast.success(enabled ? "Sign-in turned on" : "Sign-in turned off");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async () =>
      responseJson(
        await api.api.admin["saml-applications"][":id"].$delete({
          param: { id: application.id },
        })
      ),
    onSuccess: async () => {
      toast.success(`${application.name} removed`);
      await refreshAdmin(queryClient);
      queryClient.removeQueries({
        queryKey: ["saml-application", application.id],
      });
      onDeleted();
    },
    onError: (error) => toast.error(error.message),
  });

  const test = testSignIn({
    appUrl: application.acsUrl,
    launchUrl: application.launchUrl,
    allowIdpInitiated: application.allowIdpInitiated,
  });

  return (
    <div className="max-w-3xl space-y-5">
      <DetailHeader
        protocol="saml"
        name={application.name}
        managed={managed}
        enabled={application.enabled}
        togglePending={toggle.isPending}
        onToggle={(enabled) => toggle.mutate(enabled)}
      />
      <DetailTabs
        tab={tab}
        onTab={setTab}
        managed={managed}
        footer={
          <SaveBar
            problems={samlSaveProblems(input)}
            dirty={dirty}
            pending={save.isPending}
            onSave={() => save.mutate()}
          />
        }
      >
        {{
          overview: (
            <>
              <SamlProviderDetails provider={provider} />
              <Section
                title="Sign-in"
                description="The values this workspace needs from the app."
              >
                <Field id="saml-detail-name" label="Name">
                  <Input
                    id="saml-detail-name"
                    value={input.name}
                    disabled={managed}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </Field>
                <SamlConnectionFields
                  input={input}
                  disabled={managed}
                  onChange={update}
                />
                <TestSignInPanel
                  test={application.enabled ? test : null}
                  appLabel={application.name}
                />
                {application.enabled ? null : (
                  <p className="text-muted-foreground text-xs">
                    Turn sign-in on above to test it.
                  </p>
                )}
              </Section>
              {managed ? null : (
                <DeleteApp
                  name={application.name}
                  pending={remove.isPending}
                  onDelete={() => remove.mutate()}
                />
              )}
            </>
          ),
          access: (
            <Section
              title="Access"
              description="Who may sign in to the app, and what it learns about their teams."
            >
              <WhoCanSignIn
                teams={teams}
                value={input.accessTeams}
                sendTeams={Boolean(input.groupsAttributeName.trim())}
                readOnly={managed}
                sendTeamsHelp={`They go in the "${input.groupsAttributeName.trim() || "groups"}" attribute; rename it under Advanced.`}
                onSendTeamsChange={(on) =>
                  update({ groupsAttributeName: on ? "groups" : "" })
                }
                onChange={(accessTeams) => update({ accessTeams })}
              />
            </Section>
          ),
          provisioning: (
            <AppProvisioning
              key={`provisioning-${application.id}`}
              kind="saml-applications"
              applicationId={application.id}
              provisioning={application.provisioning}
              managed={managed}
            />
          ),
          advanced: (
            <Section
              title="Advanced"
              description="Only if the app's instructions mention these."
            >
              <SamlAdvancedFields
                input={input}
                launchUrl={application.launchUrl}
                disabled={managed}
                onChange={update}
              />
            </Section>
          ),
        }}
      </DetailTabs>
    </div>
  );
}

function DeleteApp({
  name,
  pending,
  onDelete,
}: {
  name: string;
  pending: boolean;
  onDelete: () => void;
}) {
  const { confirm, dialog: confirmDialog } = useConfirm();

  return (
    <div
      className={`${adminPanelClass} flex flex-wrap items-center justify-between gap-3 px-5 py-3.5`}
    >
      {confirmDialog}
      <p className="text-muted-foreground text-xs leading-5">
        Removing the app signs everyone out of it here. People's accounts inside
        the app stay.
      </p>
      <Button
        variant="destructive"
        disabled={pending}
        onClick={async () => {
          const confirmed = await confirm({
            title: `Remove ${name}?`,
            description:
              "Everyone is signed out of it here, and nobody can sign in to it with this workspace. People's accounts inside the app stay.",
            action: "Remove app",
            destructive: true,
          });

          if (confirmed) onDelete();
        }}
      >
        <Trash2 /> Remove app
      </Button>
    </div>
  );
}
