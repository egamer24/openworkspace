import type { User } from "./db/schema";
import type { CloudflareApiBindings } from "./admin/cloudflare-onboarding";
import type { CloudflareEmailAnalyticsBindings } from "./mail/email-authentication";

export type SessionUser = Pick<
  User,
  "id" | "name" | "avatarUrl" | "role" | "status"
>;

export type AuthBindings = {
  ALLOW_MOCK_AUTH?: string;
  IDENTITY_PROVIDER_ORIGIN?: string;
};

export type OidcBindings = {
  OIDC_SIGNING_PRIVATE_JWK?: string;
  OIDC_PREVIOUS_PUBLIC_JWKS?: string;
};

export type SamlBindings = {
  SAML_SIGNING_PRIVATE_KEY?: string;
  SAML_SIGNING_CERTIFICATE?: string;
  SAML_ADDITIONAL_SIGNING_CERTIFICATES?: string;
};

export type R2S3Bindings = {
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
};

export type PushBindings = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

/** Optional: scheduled backups are disabled until this R2 binding exists. */
export type BackupBindings = {
  BACKUP_STORAGE?: R2Bucket;
};

export type AppEnv = {
  Bindings: Env
    & AuthBindings
    & CloudflareEmailAnalyticsBindings
    & CloudflareApiBindings
    & OidcBindings
    & SamlBindings
    & R2S3Bindings
    & PushBindings
    & BackupBindings;
  Variables: {
    user: SessionUser;
    authKind: "session" | "api-token";
    sessionId: string;
    sessionTokenHash: string;
  };
};
