// Turns the repository's docs/*.md, written to be read on GitHub, into pages
// of the site: links between the docs point at /docs/<slug>, links to other
// files in the repository point at GitHub, headings link to themselves, and
// wide tables scroll on their own.

import { existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import type { SatteriProcessorOptions } from "@astrojs/markdown-satteri";
import GithubSlugger from "github-slugger";

type HastPlugins = NonNullable<SatteriProcessorOptions["hastPlugins"]>;

const repository = "https://github.com/iivankin/openworkspace";
const branch = "master";
const scheme = /^[a-z][a-z\d+.-]*:/iu;
const docFile = /^docs\/([^/]+)\.md$/u;

/**
 * Where a link written in docs/*.md goes on the site, or `undefined` to keep
 * it as written (absolute URLs, same-page anchors, site paths).
 */
export function siteHref(href: string, repoRoot: string): string | undefined {
  const kept =
    href === "" ||
    href.startsWith("#") ||
    href.startsWith("/") ||
    scheme.test(href);

  if (kept) return;

  const hashAt = href.indexOf("#");
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const target = posix.normalize(posix.join("docs", path));

  if (target.startsWith("../")) return;

  const absolute = join(repoRoot, target);
  const doc = docFile.exec(target);

  if (doc && existsSync(absolute)) return `/docs/${doc[1]}${hash}`;

  const kind =
    existsSync(absolute) && statSync(absolute).isDirectory() ? "tree" : "blob";

  return `${repository}/${kind}/${branch}/${target.replace(/\/$/u, "")}${hash}`;
}

export function docsMarkdown(repoRoot: string): HastPlugins {
  return [
    {
      name: "docs-links",
      element: {
        filter: ["a"],
        visit(node, ctx) {
          const { href } = node.properties;

          if (href == null) return;

          const rewritten = siteHref(String(href), repoRoot);

          if (rewritten !== undefined) ctx.setProperty(node, "href", rewritten);
        },
      },
    },
    {
      name: "docs-tables",
      element: {
        filter: ["table"],
        visit(node, ctx) {
          ctx.wrapNode(node, {
            type: "element",
            tagName: "div",
            properties: { className: ["table-wrap"] },
            children: [],
          });
        },
      },
    },
    // A fresh slugger for each document: the same ids GitHub gives the
    // headings, set before Astro's own heading pass, which keeps them.
    () => {
      const slugger = new GithubSlugger();

      return {
        name: "docs-heading-links",
        element: {
          filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
          visit(node, ctx) {
            const id = slugger.slug(ctx.textContent(node));

            ctx.setProperty(node, "id", id);

            if (node.tagName === "h1") return;

            ctx.setField(node, "children", [
              {
                type: "element",
                tagName: "a",
                properties: { className: ["heading-link"], href: `#${id}` },
                children: [...node.children],
              },
            ]);
          },
        },
      };
    },
  ];
}
