const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hasAllowedWebScheme(url: URL) {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHosts.has(url.hostname))
  );
}

export function isAllowedOidcRedirectUri(value: string) {
  try {
    const url = new URL(value);

    return (
      hasAllowedWebScheme(url) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

export function normalizeAllowedOidcOrigin(value: string) {
  try {
    const url = new URL(value);

    if (
      !hasAllowedWebScheme(url) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}
