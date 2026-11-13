// The docs: the repository's docs/*.md, in the order and groups the sidebar
// shows, with the short name the sidebar uses and the one-line summary the
// docs index and each page's description use.
//
// The Markdown is written and rewritten on its own, so the site takes what is
// there: a page listed here without a file is left out, and a file not listed
// here still gets a page, under "More", named after its first heading.

import { getCollection } from "astro:content";
import type { CollectionEntry } from "astro:content";

type ListedPage = {
  slug: string;
  label: string;
  summary: string;
};

type Group = {
  title: string;
  pages: readonly ListedPage[];
};

const groups: readonly Group[] = [
  {
    title: "Get started",
    pages: [
      {
        slug: "deploy",
        label: "Deploy",
        summary:
          "What you need, how to create and deploy a workspace, how mail domains are set up, and how to update.",
      },
      {
        slug: "configuration",
        label: "Configuration",
        summary:
          "The props, AI providers and secrets you set in alchemy.run.ts.",
      },
      {
        slug: "migration",
        label: "Migration",
        summary:
          "Move people, teams and mail from Google Workspace, mbox files or IMAP, then switch your mail over.",
      },
    ],
  },
  {
    title: "Use and connect",
    pages: [
      {
        slug: "mail",
        label: "Using the workspace",
        summary:
          "How people sign in, how mailboxes and shared inboxes work, sender warnings, AI sorting, notifications, and administration.",
      },
      {
        slug: "sso",
        label: "Single sign-on",
        summary:
          "Let people sign in to your other apps over OpenID Connect or SAML, create their accounts with SCIM, and declare apps in code.",
      },
      {
        slug: "mcp-and-jmap",
        label: "MCP and JMAP",
        summary:
          "Connect AI agents over MCP and mail apps over JMAP, choose what each may do, and manage connected apps.",
      },
      {
        slug: "webhooks",
        label: "Webhooks",
        summary:
          "Send workspace events to your own endpoints, verify the deliveries, and declare endpoints in code.",
      },
    ],
  },
  {
    title: "Build",
    pages: [
      {
        slug: "modules",
        label: "Modules",
        summary:
          "Add your own app to the workspace with the scaffold and core's public API, then its tables, routes, screens and tests.",
      },
      {
        slug: "development",
        label: "Development",
        summary:
          "Work on the OpenWorkspace repository: run it locally, run the checks and tests, and release.",
      },
    ],
  },
];

export type DocPage = ListedPage & {
  group: string;
  entry: CollectionEntry<"docs">;
};

export type DocGroup = {
  title: string;
  pages: readonly DocPage[];
};

export const editBase =
  "https://github.com/iivankin/openworkspace/edit/master/docs";

const firstHeading = /^#\s+(.+)$/mu;

/** The docs pages in sidebar order, grouped, from the files that exist. */
export async function loadDocs(): Promise<readonly DocGroup[]> {
  const entries = await getCollection("docs");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const listed = new Set(
    groups.flatMap(({ pages }) => pages.map(({ slug }) => slug))
  );

  const known: DocGroup[] = groups.map(({ title, pages }) => ({
    title,
    pages: pages.flatMap((page) => {
      const entry = byId.get(page.slug);

      return entry ? [{ ...page, group: title, entry }] : [];
    }),
  }));

  const more: DocPage[] = entries
    .flatMap((entry) =>
      listed.has(entry.id)
        ? []
        : [
            {
              slug: entry.id,
              label:
                firstHeading.exec(entry.body ?? "")?.[1]?.trim() ?? entry.id,
              summary: "",
              group: "More",
              entry,
            },
          ]
    )
    .toSorted((a, b) => a.slug.localeCompare(b.slug));

  return [...known, { title: "More", pages: more }].filter(
    ({ pages }) => pages.length > 0
  );
}

/** Every page in reading order, for prev/next links. */
export function readingOrder(docGroups: readonly DocGroup[]): DocPage[] {
  return docGroups.flatMap(({ pages }) => pages);
}
