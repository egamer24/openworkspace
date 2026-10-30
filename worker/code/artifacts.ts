/**
 * Server-side access to Cloudflare Artifacts. Repo tokens never leave the
 * Worker: clients authenticate to the workspace, and the proxy forwards Git
 * traffic with a short-lived Artifacts token.
 */

export type ArtifactsBindings = {
  ARTIFACTS?: Artifacts;
};

export type GitUpstream = {
  remote: string;
  /** Value for the `Authorization` header sent to the Artifacts remote. */
  authorization: string;
};

type TokenScope = "read" | "write";

const TOKEN_TTL_SECONDS = 60 * 60;
/** Reuse a token only while enough lifetime remains for a long transfer. */
const TOKEN_MIN_REMAINING_MS = 20 * 60 * 1_000;

const upstreamCache = new Map<string, GitUpstream & { expiresAt: number }>();

export class ArtifactsUnavailableError extends Error {}

export function artifactsBinding(env: ArtifactsBindings) {
  if (!env.ARTIFACTS) {
    throw new ArtifactsUnavailableError("The Artifacts binding is not configured");
  }
  return env.ARTIFACTS;
}

export function isArtifactsError(
  error: unknown,
  code: ArtifactsErrorCode,
): error is ArtifactsError {
  return error instanceof Error
    && error.name === "ArtifactsError"
    && (error as Partial<ArtifactsError>).code === code;
}

/**
 * Repo handles are RPC capabilities; release them before the request ends
 * instead of waiting for garbage collection.
 */
export async function withArtifactsRepo<T>(
  env: ArtifactsBindings,
  artifactsName: string,
  use: (repo: ArtifactsRepo) => Promise<T>,
): Promise<T> {
  const repo = await artifactsBinding(env).get(artifactsName);
  try {
    return await use(repo);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

/** Artifacts tokens carry `?expires=<unix>` after the secret used for Basic auth. */
function basicAuthorization(token: string) {
  const secret = token.split("?expires=", 1)[0]!;
  return `Basic ${btoa(`x:${secret}`)}`;
}

export async function gitUpstream(
  env: ArtifactsBindings,
  artifactsName: string,
  scope: TokenScope,
): Promise<GitUpstream> {
  const key = `${artifactsName}\n${scope}`;
  const cached = upstreamCache.get(key);
  if (cached && cached.expiresAt - Date.now() > TOKEN_MIN_REMAINING_MS) {
    return cached;
  }
  const upstream = await withArtifactsRepo(env, artifactsName, async (repo) => {
    const [info, token] = await Promise.all([
      repo.info(),
      repo.createToken(scope, TOKEN_TTL_SECONDS),
    ]);
    return {
      remote: info.remote.replace(/\/+$/u, ""),
      authorization: basicAuthorization(token.plaintext),
      expiresAt: Date.parse(token.expiresAt),
    };
  });
  upstreamCache.set(key, upstream);
  return upstream;
}

export function forgetGitUpstream(artifactsName: string) {
  upstreamCache.delete(`${artifactsName}\nread`);
  upstreamCache.delete(`${artifactsName}\nwrite`);
}
