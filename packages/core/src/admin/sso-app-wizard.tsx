import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { buttonVariants, Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import { api, responseJson } from "../lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import {
  SamlAdvancedFields,
  SamlConnectionFields,
  samlInputFromMetadata,
  SamlMetadataImport,
} from "./saml-app-fields";
import {
  AdvancedSection,
  Field,
  OidcAdvancedFields,
  OidcRedirectField,
  OidcScopesField,
  WhoCanSignIn,
} from "./sso-app-fields";
import {
  newOidcApp,
  newSamlApp,
  oidcPayload,
  oidcSaveProblems,
  samlPayload,
  samlSaveProblems,
  testSignIn,
} from "./sso-app-model";
import type { OidcAppInput, SamlAppInput } from "./sso-app-model";
import {
  OidcProviderDetails,
  SamlProviderDetails,
} from "./sso-provider-details";
import type { AdminOidcProvider, AdminSamlProvider, AdminTeam } from "./types";

type Protocol = "oidc" | "saml";

type Created =
  | { protocol: "oidc"; id: string; clientSecret?: string }
  | { protocol: "saml"; id: string };

const protocols: {
  value: Protocol;
  label: string;
  description: string;
}[] = [
  {
    value: "oidc",
    label: "OpenID Connect (OIDC, OAuth)",
    description:
      "The app's SSO settings ask for a client ID and secret, an issuer, or a discovery URL.",
  },
  {
    value: "saml",
    label: "SAML",
    description:
      "The app's SSO settings mention SAML, an entity ID, an ACS URL, metadata, or a certificate.",
  },
];

/**
 * Adding an app: say how it signs people in and fill in what it shows on its
 * SSO settings page, then give it this workspace's values.
 */
export function SsoAppWizard({
  oidcProvider,
  samlProvider,
  teams,
  onFinished,
}: {
  oidcProvider: AdminOidcProvider;
  samlProvider: AdminSamlProvider;
  teams: AdminTeam[];
  onFinished: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const protocolLabel = useId();
  const [protocol, setProtocol] = useState<Protocol | null>(null);
  const [oidc, setOidc] = useState<OidcAppInput>(() => newOidcApp());
  const [saml, setSaml] = useState<SamlAppInput>(() => newSamlApp());
  const [created, setCreated] = useState<Created | null>(null);

  const name = protocol === "saml" ? saml.name : oidc.name;
  const label = name.trim() || "the app";

  const create = useMutation({
    mutationFn: async (): Promise<Created> => {
      if (protocol === "oidc") {
        const result = await responseJson(
          await api.api.admin["oidc-clients"].$post({ json: oidcPayload(oidc) })
        );

        return {
          protocol: "oidc",
          id: result.clientId,
          clientSecret: result.clientSecret,
        };
      }

      const result = await responseJson(
        await api.api.admin["saml-applications"].$post({
          json: samlPayload(saml),
        })
      );

      return { protocol: "saml", id: result.applicationId };
    },
    onSuccess: async (result) => {
      setCreated(result);
      toast.success(`${label} added`);
      await queryClient.invalidateQueries({ queryKey: ["admin-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const problems = protocol
    ? protocol === "oidc"
      ? oidcSaveProblems(oidc)
      : samlSaveProblems(saml)
    : ["Choose how the app signs people in"];

  if (created) {
    const launchUrl =
      created.protocol === "saml" && samlProvider.entityId
        ? new URL(
            `/saml/launch/${created.id}`,
            samlProvider.entityId
          ).toString()
        : null;

    const test = testSignIn({
      appUrl: created.protocol === "oidc" ? oidc.redirectUri : saml.acsUrl,
      launchUrl,
      allowIdpInitiated: saml.allowIdpInitiated,
    });

    return (
      <div className="max-w-3xl space-y-5">
        {created.protocol === "oidc" ? (
          <OidcProviderDetails
            provider={oidcProvider}
            clientId={created.id}
            clientSecret={created.clientSecret}
            clientType={oidc.clientType}
          />
        ) : (
          <SamlProviderDetails provider={samlProvider} />
        )}
        <section className={adminPanelClass}>
          <AdminPanelHeader
            title="Then test sign-in"
            description={`After saving these in ${label}, check that it signs people in.`}
          />
          <AdminPanelBody>
            <TestSignInPanel test={test} appLabel={label} />
          </AdminPanelBody>
          <AdminPanelFooter>
            <Button onClick={() => onFinished(created.id)}>
              Open app settings
            </Button>
          </AdminPanelFooter>
        </section>
      </div>
    );
  }

  return (
    <section className={`${adminPanelClass} max-w-3xl`}>
      <AdminPanelHeader
        title="Add an app"
        description="Open the app's single sign-on (SSO) settings next to this page; you will copy values both ways."
      />
      <AdminPanelBody className="space-y-6">
        <div className="min-w-0">
          <p
            id={protocolLabel}
            className="text-foreground/85 mb-1 text-[0.8125rem] font-semibold"
          >
            How does the app sign people in?
          </p>
          <p className="text-muted-foreground mb-2.5 text-xs leading-5">
            Look at the words on the app's SSO settings page. If it offers both,
            pick OpenID Connect.
          </p>
          <RadioGroup
            className="sm:grid-cols-2"
            aria-labelledby={protocolLabel}
            value={protocol}
            onValueChange={(value) => setProtocol(value)}
          >
            {protocols.map((option) => (
              <RadioCard key={option.value} value={option.value}>
                <span>
                  <span className="block text-sm font-semibold">
                    {option.label}
                  </span>
                  <span className="text-muted-foreground block text-xs leading-5">
                    {option.description}
                  </span>
                </span>
              </RadioCard>
            ))}
          </RadioGroup>
        </div>

        {protocol ? (
          <Field
            id="sso-app-name"
            label="Name"
            help="Shown to people on the sign-in and consent screens."
          >
            <Input
              id="sso-app-name"
              value={name}
              onChange={(event) =>
                protocol === "oidc"
                  ? setOidc({ ...oidc, name: event.target.value })
                  : setSaml({ ...saml, name: event.target.value })
              }
            />
          </Field>
        ) : null}

        {protocol === "oidc" ? (
          <>
            <OidcRedirectField
              id="sso-redirect-uri"
              value={oidc.redirectUri}
              onChange={(redirectUri) => setOidc({ ...oidc, redirectUri })}
            />
            <OidcScopesField
              value={oidc.allowedScopes}
              onChange={(allowedScopes) => setOidc({ ...oidc, allowedScopes })}
            />
            <WhoCanSignIn
              teams={teams}
              value={oidc.accessTeams}
              sendTeams={oidc.allowedScopes.includes("groups")}
              onChange={(accessTeams) => setOidc({ ...oidc, accessTeams })}
            />
            <AdvancedSection>
              <OidcAdvancedFields
                input={oidc}
                creating
                onChange={(patch) => setOidc({ ...oidc, ...patch })}
              />
            </AdvancedSection>
          </>
        ) : null}

        {protocol === "saml" ? (
          <>
            <SamlMetadataImport
              onImported={(draft) =>
                setSaml(samlInputFromMetadata(saml, draft))
              }
            />
            <SamlConnectionFields
              input={saml}
              onChange={(patch) => setSaml({ ...saml, ...patch })}
            />
            <WhoCanSignIn
              teams={teams}
              value={saml.accessTeams}
              sendTeams={Boolean(saml.groupsAttributeName.trim())}
              sendTeamsHelp={`They go in the "${saml.groupsAttributeName.trim() || "groups"}" attribute.`}
              onSendTeamsChange={(on) =>
                setSaml({ ...saml, groupsAttributeName: on ? "groups" : "" })
              }
              onChange={(accessTeams) => setSaml({ ...saml, accessTeams })}
            />
            <AdvancedSection>
              <SamlAdvancedFields
                input={saml}
                onChange={(patch) => setSaml({ ...saml, ...patch })}
              />
            </AdvancedSection>
          </>
        ) : null}
      </AdminPanelBody>
      <AdminPanelFooter>
        <SaveProblems problems={problems} />
        <Button
          disabled={problems.length > 0 || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Check />
          )}
          Add app
        </Button>
      </AdminPanelFooter>
    </section>
  );
}

export function TestSignInPanel({
  test,
  appLabel,
}: {
  test: ReturnType<typeof testSignIn>;
  appLabel: string;
}) {
  if (!test) {
    return (
      <p className="text-muted-foreground text-sm">
        Open {appLabel} and choose its single sign-on option to try it.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <a
        className={buttonVariants({ variant: "default" })}
        href={test.url}
        target="_blank"
        rel="noreferrer"
      >
        <ExternalLink /> Test sign-in
      </a>
      <p className="text-muted-foreground min-w-0 flex-1 text-xs leading-5">
        {test.hint}
      </p>
    </div>
  );
}

/** Says why a button is disabled instead of leaving it greyed out silently. */
export function SaveProblems({
  problems,
  prefix = "To continue",
}: {
  problems: string[];
  prefix?: string;
}) {
  if (problems.length === 0) return null;

  return (
    <p
      className="text-muted-foreground min-w-0 flex-1 text-xs leading-5"
      role="status"
    >
      {prefix}: {problems.join("; ")}.
    </p>
  );
}
