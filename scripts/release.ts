#!/usr/bin/env bun
/**
 * Publishes @open-workspace/core, email and create to npm, in that order
 * (email takes core as a peer, create scaffolds both), for the release
 * workflow (.github/workflows/release.yml).
 *
 *   bun scripts/release.ts --tag v0.4.0 [--check | --dry-run]
 *
 * `--check` only checks the versions; `--dry-run` packs and runs
 * `npm publish --dry-run`.
 *
 * - The tag must name the version every package carries, and the
 *   versions the packages pin each other at must agree with it.
 * - `bun pm pack` builds each tarball, so `workspace:*` ranges become
 *   real versions, and only the package's `files` ship.
 * - `npm publish <tarball>` publishes it. In GitHub Actions npm signs in
 *   with the workflow's OIDC token (trusted publishing) and attaches
 *   provenance on its own; no npm token is involved.
 * - A version already on npm is skipped, so a re-run after a partial
 *   failure publishes only what is missing.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import coreManifest from "../packages/core/package.json" with { type: "json" };
import createManifest from "../packages/create/package.json" with { type: "json" };
import { versions } from "../packages/create/templates.ts";
import emailManifest from "../packages/email/package.json" with { type: "json" };

const root = path.resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const checkOnly = args.includes("--check");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex === -1 ? process.env.GITHUB_REF_NAME : args[tagIndex + 1];

if (!tag) {
  throw new Error(
    "Pass the release tag: --tag v1.2.3 (or set GITHUB_REF_NAME)"
  );
}

const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag)?.[1];

if (!version) throw new Error(`The tag ${tag} is not v<semver>`);

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  repository?: { url?: string };
  peerDependencies?: Record<string, string>;
};

/** The packages in publishing order, their manifests imported (typed from the files themselves). */
const manifests: { dir: string; manifest: Manifest }[] = [
  { dir: path.join(root, "packages/core"), manifest: coreManifest },
  { dir: path.join(root, "packages/email"), manifest: emailManifest },
  { dir: path.join(root, "packages/create"), manifest: createManifest },
];

const problems: string[] = [];

for (const { manifest } of manifests) {
  if (manifest.version !== version) {
    problems.push(
      `${manifest.name} is ${manifest.version}, the tag says ${version}`
    );
  }

  if (manifest.private) problems.push(`${manifest.name} is private`);

  // Trusted publishing checks the provenance's repository against this field.
  if (
    manifest.repository?.url !==
    "git+https://github.com/iivankin/openworkspace.git"
  ) {
    problems.push(
      `${manifest.name}'s repository.url is not github.com/iivankin/openworkspace`
    );
  }
}

const email: Manifest = emailManifest;

if (email.peerDependencies?.["@open-workspace/core"] !== version) {
  problems.push(
    `@open-workspace/email takes core ${email.peerDependencies?.["@open-workspace/core"]} as a peer, not ${version}`
  );
}

if (versions.openWorkspace !== version) {
  problems.push(
    `the create template installs ${versions.openWorkspace} (packages/create/templates.ts), not ${version}`
  );
}

if (problems.length) {
  console.error(
    `Not releasing ${tag}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`
  );
  process.exit(1);
}

if (checkOnly) {
  console.log(
    `${tag} matches ${manifests.map(({ manifest }) => manifest.name).join(", ")}`
  );
  process.exit(0);
}

function run(command: string[], cwd: string) {
  console.log(`$ ${command.join(" ")}`);

  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${result.exitCode}`);
  }
}

/** Whether npm already has this exact version (an unknown package or version is "no"). */
function published(name: string) {
  const result = Bun.spawnSync(
    ["npm", "view", `${name}@${version}`, "version"],
    { stdout: "pipe", stderr: "pipe" }
  );

  return result.exitCode === 0 && result.stdout.toString().trim() === version;
}

const out = mkdtempSync(path.join(tmpdir(), "openworkspace-release-"));

for (const { dir, manifest } of manifests) {
  if (published(manifest.name)) {
    console.log(`${manifest.name}@${version} is already on npm; skipping`);
    continue;
  }

  run(["bun", "pm", "pack", "--destination", out, "--quiet"], dir);

  const tarball = path.join(
    out,
    `${manifest.name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`
  );

  // Prereleases go to the `next` dist-tag, so `latest` stays on a stable version.
  const distTag = version.includes("-") ? ["--tag", "next"] : [];
  run(
    [
      "npm",
      "publish",
      tarball,
      "--access",
      "public",
      ...distTag,
      ...(dryRun ? ["--dry-run"] : []),
    ],
    root
  );
}
