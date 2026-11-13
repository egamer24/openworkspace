// Each code block in the docs becomes a <figure>: the highlighted <pre>, a
// copy button (shown by docs.ts once scripts run), and the file's name above
// the code when the fence names one: ```ts title="alchemy.run.ts".

import type { AstroUserConfig } from "astro";

type ShikiConfig = NonNullable<
  NonNullable<AstroUserConfig["markdown"]>["shikiConfig"]
>;

type ShikiTransformer = NonNullable<ShikiConfig["transformers"]>[number];

const titleMeta = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/u;

/** The file name a fence's meta string gives, if any. */
export function codeTitle(meta: string | undefined): string | undefined {
  const match = titleMeta.exec(meta ?? "");
  const title = match?.[1] ?? match?.[2] ?? match?.[3];

  return title?.trim() || undefined;
}

export const codeBlocks: ShikiTransformer = {
  name: "docs-code-blocks",
  root(root) {
    const title = codeTitle(this.options.meta?.__raw);
    const language = this.options.lang;

    return {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "figure",
          properties: {
            className: ["code-block"],
            dataLanguage: language,
          },
          children: [
            ...(title === undefined
              ? []
              : [
                  {
                    type: "element" as const,
                    tagName: "figcaption",
                    properties: { className: ["code-title"] },
                    children: [{ type: "text" as const, value: title }],
                  },
                ]),
            // Shiki's root holds the <pre> and nothing else.
            ...root.children.flatMap((child) =>
              child.type === "element" ? [child] : []
            ),
            {
              type: "element",
              tagName: "button",
              properties: {
                type: "button",
                className: ["code-copy"],
                hidden: true,
                ariaLabel: "Copy code",
                dataPagefindIgnore: "",
              },
              children: [{ type: "text", value: "Copy" }],
            },
          ],
        },
      ],
    };
  },
};
