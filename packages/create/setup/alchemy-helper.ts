#!/usr/bin/env bun
// Runs inside a new project (its working directory) with the project's own
// Alchemy, so it reads and writes Alchemy profiles exactly as `alchemy deploy`
// will. `create` spawns it and reads one JSON line from stdout:
//
//   bun alchemy-helper.ts credentials           the Cloudflare credentials a deploy would use
//   bun alchemy-helper.ts profiles              every profile's Cloudflare method and account
//   bun alchemy-helper.ts set-account <id>      point the profile's Cloudflare login at an account
//
// The profile is the one Alchemy selects: $ALCHEMY_PROFILE, else "default".
// Nothing here prompts; signing in is `alchemy profile edit`, run by create.
import { join } from "node:path";

import type {
  CloudflareAuthConfig,
  CloudflareResolvedCredentials,
} from "@alchemy.run/cloudflare/Auth/AuthConfig";
import type { Services } from "alchemy/Alchemist/Runtime";
import type { AuthProviders } from "alchemy/Auth/AuthProvider";
import type { Effect as Program } from "effect/Effect";
import type { Scope } from "effect/Scope";

import type {
  CredentialsReply,
  HelperReply,
  ProfilesReply,
  SetAccountReply,
} from "./alchemy-protocol.ts";

/** Resolves a module from the project's dependencies, not this package's. */
function fromProject(specifier: string) {
  return Bun.resolveSync(specifier, join(process.cwd(), "package.json"));
}

const Effect: typeof import("effect/Effect") = await import(
  fromProject("effect/Effect")
);

const Layer: typeof import("effect/Layer") = await import(
  fromProject("effect/Layer")
);

const Option: typeof import("effect/Option") = await import(
  fromProject("effect/Option")
);

const Schema: typeof import("effect/Schema") = await import(
  fromProject("effect/Schema")
);

const Redacted: typeof import("effect/Redacted") = await import(
  fromProject("effect/Redacted")
);

const Alchemist: typeof import("alchemy/Alchemist") = await import(
  fromProject("alchemy/Alchemist")
);

const Auth: typeof import("alchemy/Auth/AuthProvider") = await import(
  fromProject("alchemy/Auth/AuthProvider")
);

const Profile: typeof import("alchemy/Auth/Profile") = await import(
  fromProject("alchemy/Auth/Profile")
);

const Resolve: typeof import("alchemy/Auth/Resolve") = await import(
  fromProject("alchemy/Auth/Resolve")
);

const CloudflareAuth: typeof import("@alchemy.run/cloudflare/Auth/AuthProvider") =
  await import(fromProject("@alchemy.run/cloudflare/Auth/AuthProvider"));

const CloudflareConfig: typeof import("@alchemy.run/cloudflare/Auth/AuthConfig") =
  await import(fromProject("@alchemy.run/cloudflare/Auth/AuthConfig"));

const PROVIDER = CloudflareConfig.CLOUDFLARE_AUTH_PROVIDER_NAME;

const storedAccountSchema = Schema.Struct({
  method: Schema.String,
  accountId: Schema.optional(Schema.String),
});

/**
 * The Cloudflare credentials `alchemy deploy` resolves, by the same rules:
 * CLOUDFLARE_API_TOKEN (or _API_KEY) with CLOUDFLARE_ACCOUNT_ID first, then
 * the selected profile, refreshing an expired OAuth token and saving it.
 */
function credentials() {
  return Effect.gen(function* () {
    const registry: AuthProviders["Service"] = {};
    const withRegistry = Effect.provideService(Auth.AuthProviders, registry);

    yield* Layer.build(CloudflareAuth.CloudflareAuth).pipe(withRegistry);

    const store = yield* Profile.ProfileStore;
    const { name: profile } = yield* store.current;

    const stored = Schema.decodeUnknownOption(storedAccountSchema)(
      (yield* store.getProfile(profile))?.providers[PROVIDER]
    );

    const selected = yield* Resolve.resolveProviderConfig<
      CloudflareAuthConfig,
      CloudflareResolvedCredentials
    >(PROVIDER).pipe(
      withRegistry,
      Effect.provideService(Profile.SuppressMissingProviderConfig, true)
    );

    const resolved = yield* selected.resolve;
    const { source } = selected;

    const auth =
      resolved.type === "apiKey"
        ? {
            type: "apiKey" as const,
            key: Redacted.value(resolved.apiKey),
            email: Redacted.value(resolved.email),
          }
        : {
            type: "token" as const,
            token: Redacted.value(
              resolved.type === "apiToken"
                ? resolved.apiToken
                : resolved.accessToken
            ),
          };

    const reply: CredentialsReply = {
      status: "ok",
      source,
      profile,
      method:
        source === "environment"
          ? "environment"
          : Option.match(stored, {
              onNone: () => "unknown",
              onSome: (value) => value.method,
            }),
      accountId: resolved.accountId,
      auth,
    };

    return reply;
  }).pipe(
    Effect.catch((failure) => {
      const reply: CredentialsReply = {
        status:
          failure._tag === "MissingProviderConfig" ? "missing" : "invalid",
        message: failure.message,
      };

      return Effect.succeed(reply);
    })
  );
}

/** Every profile with a Cloudflare login, and the account it deploys to. */
function profiles() {
  return Effect.gen(function* () {
    const store = yield* Profile.ProfileStore;
    const { name: active } = yield* store.current;
    const manifest = yield* store.readManifest;

    const reply: ProfilesReply = {
      status: "ok",
      active,
      profiles: Object.entries(manifest.profiles).map(([name, profile]) => ({
        name,
        cloudflare: Option.getOrUndefined(
          Schema.decodeUnknownOption(storedAccountSchema)(
            profile.providers[PROVIDER]
          )
        ),
      })),
    };

    return reply;
  }).pipe(
    Effect.catch((failure) => {
      const reply: ProfilesReply = {
        status: "invalid",
        message: failure.message,
      };

      return Effect.succeed(reply);
    })
  );
}

/** Points the selected profile's Cloudflare login at another account its credentials reach. */
function setAccount(accountId: string) {
  return Effect.gen(function* () {
    const store = yield* Profile.ProfileStore;
    const { name: profile } = yield* store.current;
    const stored = (yield* store.getProfile(profile))?.providers[PROVIDER];

    if (stored === undefined) {
      const missing: SetAccountReply = {
        status: "missing",
        message: `Profile '${profile}' has no Cloudflare login.`,
      };

      return missing;
    }

    const id = yield* CloudflareConfig.validateAccountId(
      accountId,
      "chosen in bun create @open-workspace"
    );

    yield* store.setProviderConfig(profile, PROVIDER, {
      ...stored,
      accountId: id,
    });

    const reply: SetAccountReply = { status: "ok", profile, accountId: id };

    return reply;
  }).pipe(
    Effect.catch((failure) => {
      const reply: SetAccountReply = {
        status: "invalid",
        message: failure.message,
      };

      return Effect.succeed(reply);
    })
  );
}

/** Runs one command under Alchemy's own services (profile store, credentials store, HTTP). */
function run(program: Program<HelperReply, never, Services | Scope>) {
  return Effect.runPromise(
    program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped)
  );
}

const [command, argument] = process.argv.slice(2);

const reply =
  command === "credentials"
    ? await run(credentials())
    : command === "profiles"
      ? await run(profiles())
      : command === "set-account" && argument
        ? await run(setAccount(argument))
        : undefined;

if (reply === undefined) {
  process.stderr.write(
    "Usage: alchemy-helper.ts credentials | profiles | set-account <account id>\n"
  );
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}
