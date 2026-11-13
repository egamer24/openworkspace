import { useQuery } from "@tanstack/react-query";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import { identityScopes, isOidcScopeName } from "../../shared/oidc";
import type { OidcScope } from "../../shared/oidc";
import { useAuth } from "../auth/auth-context";
import { Checkbox } from "../components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { adminStateQuery } from "./admin-state";
import { identityScopeDescriptions } from "./sso-app-model";
import type { AccessTeamInput, OidcAppInput } from "./sso-app-model";
import type { AdminTeam } from "./types";

export function Field({
  label,
  id,
  help,
  children,
}: {
  label: string;
  id: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? (
        <p className="text-muted-foreground text-xs leading-5">{help}</p>
      ) : null}
    </div>
  );
}

export function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-3">
      <span>
        <span className="block text-[0.8125rem] font-semibold">{label}</span>
        <span className="text-muted-foreground block text-xs leading-5">
          {description}
        </span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}

function UrlListField({
  id,
  label,
  help,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label} help={`${help} One per line.`}>
      <Textarea
        id={id}
        className="min-h-16 font-mono text-xs"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** A folded "Advanced" area for settings most apps never need. */
export function AdvancedSection({
  defaultOpen = false,
  children,
}: {
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="ring-border rounded-xl ring-1"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left text-[0.8125rem] font-semibold">
        <ChevronDown className="text-muted-foreground size-4 transition-transform group-data-[panel-open]:rotate-180" />
        Advanced
        <span className="text-muted-foreground font-normal">
          Only if the app's instructions mention these
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-border/70 space-y-5 border-t px-4 py-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function RadioCardText({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <span>
      <span className="block text-sm font-semibold">{label}</span>
      <span className="text-muted-foreground block text-xs leading-5">
        {description}
      </span>
    </span>
  );
}

/** Everyone's team first, then the rest by name. */
function accessTeamOrder(teams: AdminTeam[]) {
  return [...teams].sort(
    (a, b) =>
      Number(b.everyone) - Number(a.everyone) || a.name.localeCompare(b.name)
  );
}

/** In words: who the chosen teams let in, and what the app receives for each. */
function describeAccess(
  teams: AdminTeam[],
  accessTeams: AccessTeamInput[],
  sendTeams: boolean
) {
  const chosen = accessTeamOrder(teams).flatMap((team) => {
    const access = accessTeams.find((item) => item.teamId === team.id);

    return access ? [{ team, sentAs: access.sentAs.trim() }] : [];
  });

  if (!chosen.length) return ["Nobody"];

  return chosen.map(({ team, sentAs }) => {
    const name = team.everyone
      ? "Everyone in the workspace"
      : `Members of ${team.name}`;

    return sendTeams && sentAs ? `${name}, sent to the app as ${sentAs}` : name;
  });
}

/**
 * "Who can sign in?": the teams whose members may. When the app is told
 * people's teams, each team can be sent as another value, such as a role
 * name the app knows.
 */
export function WhoCanSignIn({
  teams,
  value,
  sendTeams,
  sendTeamsHelp,
  readOnly,
  onSendTeamsChange,
  onChange,
}: {
  teams: AdminTeam[];
  value: AccessTeamInput[];
  /** Whether the app is told which of these teams each person is in. */
  sendTeams: boolean;
  /** Where the app reads them, e.g. the groups attribute. */
  sendTeamsHelp?: ReactNode;
  /** A switch for sending teams; without it, `sendTeams` comes from elsewhere (the groups scope). */
  onSendTeamsChange?: (on: boolean) => void;
  /** Declared in alchemy.run.ts: shown, not edited. */
  readOnly?: boolean;
  onChange: (value: AccessTeamInput[]) => void;
}) {
  const ordered = accessTeamOrder(teams);

  if (readOnly) {
    return (
      <div className="space-y-1">
        <p className="text-foreground/85 text-[0.8125rem] font-semibold">
          Who can sign in
        </p>
        {describeAccess(teams, value, sendTeams).map((line) => (
          <p key={line} className="text-sm">
            {line}
          </p>
        ))}
        <p className="text-muted-foreground pt-2 text-xs">
          {sendTeams
            ? "The app is told which of these teams each person is in."
            : "The app only learns who signed in, not their teams."}
        </p>
      </div>
    );
  }

  const chosen = new Map(value.map((item) => [item.teamId, item]));

  const toggle = (team: AdminTeam, checked: boolean) =>
    onChange(
      checked
        ? [...value, { teamId: team.id, sentAs: "" }]
        : value.filter((item) => item.teamId !== team.id)
    );

  return (
    <div className="min-w-0 space-y-2">
      <p className="text-foreground/85 text-[0.8125rem] font-semibold">
        Who can sign in?
      </p>
      <p className="text-muted-foreground text-xs leading-5">
        Members of the teams you pick. To let one person in, add them to a team.
      </p>
      {onSendTeamsChange ? (
        <div className="ring-border rounded-xl px-3.5 ring-1">
          <SwitchRow
            label="Send teams to the app"
            description={
              <>
                Give teams a value, such as a role name the app knows; the app
                receives the values of each person's teams. {sendTeamsHelp}
              </>
            }
            checked={sendTeams}
            onCheckedChange={onSendTeamsChange}
          />
        </div>
      ) : null}
      {value.length === 0 ? (
        <p className="bg-warning/12 ring-warning/30 flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-5 ring-1">
          <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" />
          Nobody can sign in yet. Pick at least one team, or Everyone.
        </p>
      ) : null}
      <fieldset className="divide-border/60 bg-surface-sunken/50 ring-border mt-3 max-h-80 divide-y overflow-y-auto rounded-xl ring-1">
        <legend className="sr-only">Teams that can sign in</legend>
        {ordered.map((team) => {
          const access = chosen.get(team.id);

          return (
            <div
              key={team.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5"
            >
              <label className="flex min-w-0 flex-1 items-center gap-3">
                <Checkbox
                  checked={Boolean(access)}
                  onCheckedChange={(checked) => toggle(team, checked)}
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold">
                    {team.name}
                  </span>
                  <span className="text-muted-foreground block truncate text-[11px]">
                    {team.everyone
                      ? "Everyone with an active account"
                      : team.slug}
                  </span>
                </span>
              </label>
              {access && sendTeams ? (
                <Input
                  aria-label={`${team.name}: sent to the app as`}
                  className="h-8 w-full font-mono text-xs sm:w-48"
                  placeholder="Value for the app, e.g. a role"
                  value={access.sentAs}
                  onChange={(event) =>
                    onChange(
                      value.map((item) =>
                        item.teamId === team.id
                          ? { ...item, sentAs: event.target.value }
                          : item
                      )
                    )
                  }
                />
              ) : null}
            </div>
          );
        })}
        {ordered.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-xs">
            No teams yet
          </p>
        ) : null}
      </fieldset>
      {sendTeams ? (
        <p className="text-muted-foreground text-xs leading-5">
          The app receives the values of the teams each person is in. A team
          without a value is not sent.
        </p>
      ) : null}
    </div>
  );
}

/** "What the app may ask for": the OpenID Connect scopes it may request. */
/** The app's callback address, under the names apps give it. */
export function OidcRedirectField({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      id={id}
      label="Redirect URL"
      help="Where the app receives people after sign-in; the app shows it on its SSO settings page. Also called the redirect URI, callback URL, sign-in redirect URL, or reply URL. More can be added under Advanced."
    >
      <Input
        id={id}
        type="url"
        className="font-mono text-xs"
        placeholder="https://app.example.com/auth/callback"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

export function OidcScopesField({
  value,
  disabled,
  onChange,
}: {
  value: OidcAppInput["allowedScopes"];
  disabled?: boolean;
  onChange: (allowedScopes: OidcAppInput["allowedScopes"]) => void;
}) {
  // Mail, people and administration scopes are an administrator's to give (the API checks too).
  const admin = useAuth().user?.role === "admin";

  const workspaceScopes = (
    useQuery(adminStateQuery).data?.availableScopes ?? []
  ).flatMap((scope) => {
    const { id } = scope;

    return isOidcScopeName(id) ? [{ ...scope, id }] : [];
  });

  const order: OidcScope[] = [
    ...identityScopes,
    ...workspaceScopes.map((scope) => scope.id),
  ];

  const toggle = (scope: OidcScope, checked: boolean) =>
    onChange(
      checked
        ? order.filter((item) => item === scope || value.includes(item))
        : value.filter((item) => item !== scope)
    );

  return (
    <fieldset className="min-w-0">
      <legend className="text-foreground/85 mb-2.5 text-[0.8125rem] font-semibold">
        What the app may ask for (scopes)
      </legend>
      <div className="bg-surface-sunken/50 ring-border grid gap-2.5 rounded-xl p-3.5 ring-1 sm:grid-cols-2">
        {identityScopes.map((scope) => (
          <label key={scope} className="flex items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={value.includes(scope)}
              disabled={disabled || scope === "openid"}
              onCheckedChange={(checked) => toggle(scope, checked)}
            />
            <span>
              <span className="block font-mono text-xs">{scope}</span>
              <span className="text-muted-foreground block text-xs">
                {identityScopeDescriptions[scope]}
              </span>
            </span>
          </label>
        ))}
      </div>
      {workspaceScopes.length ? (
        <div className="bg-surface-sunken/50 ring-border mt-3 rounded-xl p-3.5 ring-1">
          <p className="text-xs font-semibold">Workspace access</p>
          <p className="text-muted-foreground mt-0.5 text-xs leading-5 text-pretty">
            For apps that work with mail or the workspace for the person, never
            beyond what that person may do themselves. People always approve it
            on the consent screen.
            {admin ? null : " Only administrators can allow it."}
          </p>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {workspaceScopes.map((scope) => {
              const { id } = scope;

              return (
                <label
                  key={scope.id}
                  className="flex items-start gap-2.5 text-sm"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={value.includes(id)}
                    disabled={disabled || (!admin && !value.includes(id))}
                    onCheckedChange={(checked) => toggle(id, checked)}
                  />
                  <span>
                    <span className="block font-mono text-xs">{scope.id}</span>
                    <span className="text-muted-foreground block text-xs">
                      {scope.label}
                    </span>
                    {scope.dangerous ? (
                      <span className="text-destructive mt-0.5 block text-xs font-medium">
                        Can take over accounts
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

export function OidcAdvancedFields({
  input,
  creating,
  disabled,
  onChange,
}: {
  input: OidcAppInput;
  creating: boolean;
  disabled?: boolean;
  onChange: (patch: Partial<OidcAppInput>) => void;
}) {
  const typeLabel = useId();
  const confidential = input.clientType === "confidential";
  const admin = useAuth().user?.role === "admin";

  return (
    <fieldset className="min-w-0 space-y-5" disabled={disabled}>
      <div className="space-y-2">
        <p
          id={typeLabel}
          className="text-foreground/85 text-[0.8125rem] font-semibold"
        >
          What kind of app is it?
        </p>
        <RadioGroup
          className="sm:grid-cols-2"
          aria-labelledby={typeLabel}
          value={input.clientType}
          disabled={disabled || !creating}
          onValueChange={(clientType: OidcAppInput["clientType"]) =>
            onChange(
              clientType === "public"
                ? { clientType, requirePkce: true }
                : { clientType }
            )
          }
        >
          <RadioCard value="confidential">
            <RadioCardText
              label="App has a backend server (keeps a secret)"
              description="Most web apps. Gets a client secret."
            />
          </RadioCard>
          <RadioCard value="public">
            <RadioCardText
              label="Runs only in the browser or on a phone (no secret)"
              description="Single-page and mobile apps. Always uses PKCE."
            />
          </RadioCard>
        </RadioGroup>
        {creating ? null : (
          <p className="text-muted-foreground text-xs">
            This cannot change after the app is added. Add the app again to
            switch.
          </p>
        )}
      </div>

      <UrlListField
        id="oidc-extra-redirects"
        label="Extra redirect URLs"
        help="Other addresses the app may return to after sign-in, such as a staging site."
        placeholder="https://staging.example.com/callback"
        value={input.extraRedirectUris}
        disabled={disabled}
        onChange={(extraRedirectUris) => onChange({ extraRedirectUris })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <UrlListField
          id="oidc-logout-redirects"
          label="After sign-out, go to"
          help="Where the app may send people after they sign out here."
          placeholder="https://app.example.com/"
          value={input.postLogoutRedirectUris}
          disabled={disabled}
          onChange={(postLogoutRedirectUris) =>
            onChange({ postLogoutRedirectUris })
          }
        />
        <UrlListField
          id="oidc-origins"
          label="Browser origins"
          help="Sites whose JavaScript calls the token URL directly. Only for apps without a server."
          placeholder="https://app.example.com"
          value={input.allowedOrigins}
          disabled={disabled}
          onChange={(allowedOrigins) => onChange({ allowedOrigins })}
        />
      </div>

      <Field
        id="oidc-backchannel"
        label="Sign-out notification URL"
        help="Optional. This workspace calls it to end a person's sessions in the app when they are disabled or lose access. Also called the back-channel logout URL."
      >
        <Input
          id="oidc-backchannel"
          type="url"
          placeholder="https://app.example.com/oidc/backchannel-logout"
          value={input.backchannelLogoutUri}
          disabled={disabled}
          onChange={(event) =>
            onChange({ backchannelLogoutUri: event.target.value })
          }
        />
      </Field>

      <div className="divide-border/60 border-border/70 divide-y border-y">
        <SwitchRow
          label="Skip the consent screen"
          description={
            <>
              People go straight back to the app instead of approving what it
              can see. Use for apps your organization runs. Mail access is
              always shown to people for approval.
              {!admin && !input.trusted
                ? " Only administrators can turn this on."
                : null}
            </>
          }
          checked={input.trusted}
          disabled={disabled || (!admin && !input.trusted)}
          onCheckedChange={(trusted) => onChange({ trusted })}
        />
        <SwitchRow
          label="Require PKCE"
          description={
            confidential
              ? "An extra check that stops stolen sign-in codes from being used. Turn off only if the app cannot send it."
              : "Always on for apps without a secret."
          }
          checked={!confidential || input.requirePkce}
          disabled={disabled || !confidential}
          onCheckedChange={(requirePkce) => onChange({ requirePkce })}
        />
      </div>
    </fieldset>
  );
}
