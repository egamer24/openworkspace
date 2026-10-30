import type { CodeLanguages } from "../../shared/code";
import { withArtifactsRepo, type ArtifactsBindings } from "./artifacts";
import { resolveCommit } from "./browse";

/**
 * Repository language breakdown by bytes, like GitHub's Languages bar.
 * Only programming and markup languages count; prose, data, lockfiles, and
 * vendored or generated directories are skipped. Results are cached by root
 * tree hash because a tree's contents never change.
 */

type Language = { name: string; color: string };

const lang = (name: string, color: string): Language => ({ name, color });

/** Colors follow GitHub Linguist so the bar looks familiar. */
const LANGUAGES = {
  ts: lang("TypeScript", "#3178c6"),
  js: lang("JavaScript", "#f1e05a"),
  go: lang("Go", "#00add8"),
  rs: lang("Rust", "#dea584"),
  py: lang("Python", "#3572a5"),
  rb: lang("Ruby", "#701516"),
  java: lang("Java", "#b07219"),
  kt: lang("Kotlin", "#a97bff"),
  swift: lang("Swift", "#f05138"),
  c: lang("C", "#555555"),
  cpp: lang("C++", "#f34b7d"),
  cs: lang("C#", "#178600"),
  php: lang("PHP", "#4f5d95"),
  sh: lang("Shell", "#89e051"),
  ps1: lang("PowerShell", "#012456"),
  css: lang("CSS", "#663399"),
  scss: lang("SCSS", "#c6538c"),
  html: lang("HTML", "#e34c26"),
  vue: lang("Vue", "#41b883"),
  svelte: lang("Svelte", "#ff3e00"),
  astro: lang("Astro", "#ff5a03"),
  dart: lang("Dart", "#00b4ab"),
  ex: lang("Elixir", "#6e4a7e"),
  erl: lang("Erlang", "#b83998"),
  hs: lang("Haskell", "#5e5086"),
  lua: lang("Lua", "#000080"),
  zig: lang("Zig", "#ec915c"),
  scala: lang("Scala", "#c22d40"),
  clj: lang("Clojure", "#db5855"),
  ml: lang("OCaml", "#ef7a08"),
  sql: lang("SQL", "#e38c00"),
  tf: lang("HCL", "#844fba"),
  nix: lang("Nix", "#7e7eff"),
  dockerfile: lang("Dockerfile", "#384d54"),
  makefile: lang("Makefile", "#427819"),
  proto: lang("Protocol Buffer", "#4285f4"),
  graphql: lang("GraphQL", "#e10098"),
  sol: lang("Solidity", "#aa6746"),
  r: lang("R", "#198ce7"),
  jl: lang("Julia", "#a270ba"),
  m: lang("Objective-C", "#438eff"),
} as const;

const EXTENSIONS: Record<string, Language> = {
  ts: LANGUAGES.ts, tsx: LANGUAGES.ts, mts: LANGUAGES.ts, cts: LANGUAGES.ts,
  js: LANGUAGES.js, jsx: LANGUAGES.js, mjs: LANGUAGES.js, cjs: LANGUAGES.js,
  go: LANGUAGES.go, rs: LANGUAGES.rs, py: LANGUAGES.py, rb: LANGUAGES.rb,
  java: LANGUAGES.java, kt: LANGUAGES.kt, kts: LANGUAGES.kt, swift: LANGUAGES.swift,
  c: LANGUAGES.c, h: LANGUAGES.c,
  cc: LANGUAGES.cpp, cpp: LANGUAGES.cpp, cxx: LANGUAGES.cpp, hpp: LANGUAGES.cpp, hh: LANGUAGES.cpp,
  cs: LANGUAGES.cs, php: LANGUAGES.php,
  sh: LANGUAGES.sh, bash: LANGUAGES.sh, zsh: LANGUAGES.sh, fish: LANGUAGES.sh,
  ps1: LANGUAGES.ps1, psm1: LANGUAGES.ps1,
  css: LANGUAGES.css, scss: LANGUAGES.scss, sass: LANGUAGES.scss,
  html: LANGUAGES.html, htm: LANGUAGES.html,
  vue: LANGUAGES.vue, svelte: LANGUAGES.svelte, astro: LANGUAGES.astro,
  dart: LANGUAGES.dart, ex: LANGUAGES.ex, exs: LANGUAGES.ex, erl: LANGUAGES.erl,
  hs: LANGUAGES.hs, lua: LANGUAGES.lua, zig: LANGUAGES.zig, scala: LANGUAGES.scala,
  clj: LANGUAGES.clj, cljs: LANGUAGES.clj, ml: LANGUAGES.ml, mli: LANGUAGES.ml,
  sql: LANGUAGES.sql, tf: LANGUAGES.tf, hcl: LANGUAGES.tf, nix: LANGUAGES.nix,
  proto: LANGUAGES.proto, graphql: LANGUAGES.graphql, gql: LANGUAGES.graphql,
  sol: LANGUAGES.sol, r: LANGUAGES.r, jl: LANGUAGES.jl, m: LANGUAGES.m, mm: LANGUAGES.m,
};

const FILE_NAMES: Record<string, Language> = {
  dockerfile: LANGUAGES.dockerfile,
  containerfile: LANGUAGES.dockerfile,
  makefile: LANGUAGES.makefile,
  gnumakefile: LANGUAGES.makefile,
};

/** Directories GitHub Linguist treats as vendored or generated. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".wrangler",
  "target",
  "__pycache__",
  "third_party",
]);

const GENERATED = /(?:\.min\.(?:js|css)|\.d\.ts|\.generated\.\w+|\.pb\.go|_pb2\.py)$/u;
const MAX_FILES = 3_000;
const MAX_TREES = 1_500;
const BATCH = 16;
const CACHE_ORIGIN = "https://code-languages.openworkspace.internal";

export function languageOf(path: string): Language | null {
  const name = path.split("/").at(-1)!.toLowerCase();
  if (GENERATED.test(name)) return null;
  if (FILE_NAMES[name]) return FILE_NAMES[name]!;
  if (name.startsWith("dockerfile")) return LANGUAGES.dockerfile;
  const extension = name.includes(".") ? name.split(".").at(-1)! : "";
  return EXTENSIONS[extension] ?? null;
}

async function inBatches<T, R>(items: T[], map: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += BATCH) {
    results.push(...await Promise.all(items.slice(index, index + BATCH).map(map)));
  }
  return results;
}

function cacheStore(): Cache | null {
  return typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
}

export async function readLanguages(
  env: ArtifactsBindings,
  artifactsName: string,
  ref: string,
): Promise<CodeLanguages> {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const commit = await resolveCommit(repo, ref);
    if (!commit) return { languages: [], partial: false };
    const cache = cacheStore();
    const key = new Request(`${CACHE_ORIGIN}/${encodeURIComponent(artifactsName)}/${commit.treeHash}`);
    const cached = await cache?.match(key);
    if (cached) return cached.json<CodeLanguages>();

    const files: Array<{ hash: string; language: Language }> = [];
    let level = [{ hash: commit.treeHash, prefix: "" }];
    let treesRead = 0;
    let partial = false;
    while (level.length) {
      if (treesRead + level.length > MAX_TREES) {
        level = level.slice(0, MAX_TREES - treesRead);
        partial = true;
      }
      treesRead += level.length;
      const listings = await inBatches(level, async (tree) => ({
        prefix: tree.prefix,
        entries: await repo.readTree(tree.hash) ?? [],
      }));
      const next: typeof level = [];
      for (const { prefix, entries } of listings) {
        for (const entry of entries) {
          const path = `${prefix}${entry.name}`;
          if (entry.type === "tree") {
            if (!SKIPPED_DIRECTORIES.has(entry.name)) {
              next.push({ hash: entry.hash, prefix: `${path}/` });
            }
          } else if (entry.type === "blob" || entry.type === "exec") {
            const language = languageOf(path);
            if (language) files.push({ hash: entry.hash, language });
          }
        }
      }
      level = next;
      if (files.length > MAX_FILES) {
        files.length = MAX_FILES;
        partial = true;
        break;
      }
    }

    // The binding has no size-only call, so each blob is read once; the
    // result is cached for the tree.
    const sizes = await inBatches(files, async (file) => (await repo.readBlob(file.hash))?.size ?? 0);
    const totals = new Map<string, { language: Language; bytes: number }>();
    files.forEach((file, index) => {
      const current = totals.get(file.language.name) ?? { language: file.language, bytes: 0 };
      current.bytes += sizes[index]!;
      totals.set(file.language.name, current);
    });
    const sum = [...totals.values()].reduce((total, item) => total + item.bytes, 0);
    const result: CodeLanguages = {
      languages: [...totals.values()]
        .filter((item) => item.bytes > 0)
        .sort((left, right) => right.bytes - left.bytes)
        .map((item) => ({
          name: item.language.name,
          color: item.language.color,
          bytes: item.bytes,
          percent: sum ? (item.bytes / sum) * 100 : 0,
        })),
      partial,
    };
    await cache?.put(key, new Response(JSON.stringify(result), {
      headers: {
        "content-type": "application/json",
        "cache-control": "max-age=2592000",
      },
    }));
    return result;
  });
}
