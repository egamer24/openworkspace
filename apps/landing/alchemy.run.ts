import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "OpenWorkspaceLanding",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    // `astro build` writes the whole site, landing page and docs, to dist/,
    // which deploys as an assets-only Worker served by Cloudflare's asset
    // layer (404.html and _headers included). Alchemy's Astro resource would
    // also deploy a Worker for server rendering; this site has none.
    const site = yield* Cloudflare.Website.StaticSite("Landing", {
      command: "bun run build",
      outdir: "dist",
      // The docs pages come from the repository's docs/, outside this
      // directory, so a docs change has to trigger a rebuild too.
      memo: { include: ["**/*", "../../docs/*.md"], lockfile: true },
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "404-page",
      },
      domain: "openworkspace.dev",
      dev: { command: "bun run dev" },
    });

    return { url: site.url };
  })
);
