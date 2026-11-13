type IdentityProviderOriginBindings = {
  /** `https://<hostname>` from `OpenWorkspace({ hostname })`; http under `alchemy dev`. */
  IDENTITY_PROVIDER_ORIGIN: string;
  ALLOW_MOCK_AUTH?: string;
};

export class IdentityProviderOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityProviderOriginError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * The app's origin, which OpenWorkspace always binds: what OIDC and SAML
 * sign for and the passkeys' relying party. Plain http only for a local
 * stack (the demo sign-in on, or a loopback host).
 */
export function identityProviderOrigin(env: IdentityProviderOriginBindings) {
  let url: URL;

  try {
    url = new URL(env.IDENTITY_PROVIDER_ORIGIN.trim());
  } catch {
    throw new IdentityProviderOriginError(
      "Identity provider origin is invalid"
    );
  }

  const allowedProtocol =
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (env.ALLOW_MOCK_AUTH === "true" || LOOPBACK_HOSTS.has(url.hostname)));

  if (
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    !allowedProtocol
  ) {
    throw new IdentityProviderOriginError(
      "Identity provider origin must be an HTTPS origin without a path"
    );
  }

  return url.origin;
}
