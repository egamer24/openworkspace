import { Download, KeyRound } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "../components/ui/badge";
import { buttonVariants } from "../components/ui/button";
import { adminPanelClass, AdminPanelHeader } from "./admin-panel";
import { CopyableValueRow } from "./copyable-value-row";
import type { AdminOidcProvider, AdminSamlProvider } from "./types";

const certificateUrl = (format: "pem" | "cer") =>
  `/api/admin/saml-applications/idp-certificate?format=${format}`;

function DownloadLink({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  const className = buttonVariants({ variant: "outline", size: "sm" });

  if (!href) {
    return (
      <span
        className={`${className} pointer-events-none opacity-45`}
        aria-disabled="true"
      >
        <Download /> {children}
      </span>
    );
  }

  return (
    <a className={className} href={href} download>
      <Download /> {children}
    </a>
  );
}

function ProviderPanel({
  description,
  configured,
  configurationError,
  children,
}: {
  description: string;
  configured: boolean;
  configurationError: string | null;
  children: ReactNode;
}) {
  return (
    <section className={adminPanelClass} aria-label="Give these to the app">
      <AdminPanelHeader
        Icon={KeyRound}
        title="Give these to the app"
        description={description}
      >
        {configured ? null : (
          <Badge className="order-last" variant="warning">
            Not ready
          </Badge>
        )}
      </AdminPanelHeader>
      {configurationError ? (
        <p className="border-border/60 text-destructive border-b px-5 py-3 text-xs">
          {configurationError}. Sign-in will not work until the deployment sets
          it up.
        </p>
      ) : null}
      <div className="divide-border/60 divide-y px-5">{children}</div>
    </section>
  );
}

/**
 * What an OpenID Connect app needs from this workspace, with the other names
 * apps give each value. Most apps need only the issuer (or discovery URL),
 * client ID, and secret.
 */
export function OidcProviderDetails({
  provider,
  clientId,
  clientSecret,
  clientType,
  children,
}: {
  provider: AdminOidcProvider;
  clientId?: string;
  /** Only right after creating or rotating; it is never shown again. */
  clientSecret?: string;
  clientType?: "public" | "confidential";
  children?: ReactNode;
}) {
  return (
    <ProviderPanel
      description="Paste them into the app's single sign-on (OpenID Connect or OAuth) settings. Most apps need only the first four; the rest are for apps that ask for each URL."
      configured={provider.configured}
      configurationError={provider.configurationError}
    >
      {clientId ? (
        <CopyableValueRow
          label="Client ID"
          value={clientId}
          hint="Also called the application ID or app ID."
        />
      ) : null}
      {clientType === "confidential" ? (
        <CopyableValueRow
          label="Client secret"
          value={clientSecret ?? null}
          hint={
            clientSecret
              ? "Shown once: copy it now. It is stored only as a hash."
              : "Shown only once, when it was created. Make a new one if it was lost."
          }
        />
      ) : null}
      {clientType === "public" ? (
        <CopyableValueRow
          label="Client secret"
          value={null}
          hint="None. This app runs in the browser or on a phone and proves itself with PKCE."
        />
      ) : null}
      <CopyableValueRow
        label="Issuer"
        value={provider.issuer}
        hint="Also called the issuer URL, authority, provider URL, or domain."
      />
      <CopyableValueRow
        label="Discovery URL"
        value={provider.discoveryUrl}
        hint="Also called the well-known, metadata, or OpenID configuration URL."
      />
      <CopyableValueRow
        label="Authorization URL"
        value={provider.authorizationUrl}
        hint="Also called the auth or authorize endpoint, or login URL."
      />
      <CopyableValueRow
        label="Token URL"
        value={provider.tokenUrl}
        hint="Also called the token endpoint."
      />
      <CopyableValueRow
        label="Userinfo URL"
        value={provider.userinfoUrl}
        hint="Also called the user info, profile, or API URL."
      />
      <CopyableValueRow
        label="JWKS URL"
        value={provider.jwksUrl}
        hint="Also called the keys, certificate, or JSON Web Key Set URL."
      />
      <CopyableValueRow
        label="Sign-out URL"
        value={provider.endSessionUrl}
        hint="Also called the logout or end session URL. Optional."
      />
      {children}
    </ProviderPanel>
  );
}

/** What a SAML app needs from this workspace, with the other names apps give each value. */
export function SamlProviderDetails({
  provider,
  children,
}: {
  provider: AdminSamlProvider;
  children?: ReactNode;
}) {
  return (
    <ProviderPanel
      description="Paste them into the app's SAML single sign-on settings. If the app can read identity provider metadata, the metadata URL alone is enough."
      configured={provider.configured}
      configurationError={provider.configurationError}
    >
      <CopyableValueRow
        label="Metadata URL"
        value={provider.metadataUrl}
        hint="Also called the IdP metadata URL or federation metadata."
      />
      <CopyableValueRow
        label="SSO URL"
        value={provider.ssoUrl}
        hint="Also called the sign-in URL, login URL, IdP SSO URL, or SAML 2.0 endpoint."
      />
      <CopyableValueRow
        label="Entity ID"
        value={provider.entityId}
        hint="Also called the issuer, IdP entity ID, or identity provider identifier."
      />
      <CopyableValueRow
        label="Certificate"
        value={provider.certificatePem}
        hint="Also called the X.509, signing, or IdP certificate. Copy the text, or download it below."
      />
      <div className="flex flex-wrap items-center gap-2 py-3">
        <DownloadLink href={provider.configured ? certificateUrl("pem") : null}>
          Download .pem
        </DownloadLink>
        <DownloadLink href={provider.configured ? certificateUrl("cer") : null}>
          Download .cer
        </DownloadLink>
        <span className="text-muted-foreground text-[11px]">
          .pem when the app wants text, .cer when it wants a file.
          {provider.certificateFingerprint
            ? ` SHA-256 fingerprint ${provider.certificateFingerprint}.`
            : ""}
          {provider.certificateExpiresAt
            ? ` Valid until ${new Date(provider.certificateExpiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.`
            : ""}
        </span>
      </div>
      {children}
    </ProviderPanel>
  );
}
