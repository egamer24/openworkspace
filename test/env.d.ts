declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
    BACKUP_STORAGE: R2Bucket;
    VAPID_PUBLIC_KEY: string;
    VAPID_PRIVATE_KEY: string;
    VAPID_SUBJECT: string;
    IDENTITY_PROVIDER_ORIGIN: string;
    SAML_SIGNING_PRIVATE_KEY: string;
    SAML_SIGNING_CERTIFICATE: string;
    SAML_ADDITIONAL_SIGNING_CERTIFICATES?: string;
  }
}
