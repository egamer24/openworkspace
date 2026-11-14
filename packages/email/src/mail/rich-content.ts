import { mergeAttributes, Node } from "@tiptap/react";

import type { StoredImageRef } from "../../shared/rich-content";

/**
 * Saved rich content (a signature; auto-replies later) in the composer's
 * editor. Its images are already in R2, so the editor shows them from there
 * as `storedImage` nodes instead of uploading them again; a message sends
 * them as references (`storedImages`) and the Worker copies them in, and a
 * saved editor keeps them by content id (worker/mail/rich-content.ts).
 */

/**
 * Saved HTML made ready for the editor: each `cid:` image becomes a stored
 * image of `ownerId`, shown from `imageUrl(contentId)`.
 */
export function storedImagesHtml(
  html: string,
  ownerId: string,
  imageUrl: (contentId: string) => string
) {
  const document = new DOMParser().parseFromString(html, "text/html");

  for (const image of document.querySelectorAll("img")) {
    const source = image.getAttribute("src") ?? "";

    if (!source.startsWith("cid:")) {
      image.remove();
      continue;
    }

    image.dataset.storedOwner = ownerId;
    image.dataset.src = imageUrl(source.slice(4));
  }

  return document.body.innerHTML;
}

/**
 * Takes the stored images out of serialized editor HTML: their references,
 * with the `img` left as a plain `cid:` image for sending or saving.
 */
export function takeStoredImages(root: Element): StoredImageRef[] {
  return Array.from(
    root.querySelectorAll<HTMLImageElement>("img[data-stored-owner]"),
    (image) => {
      const ownerId = image.dataset.storedOwner ?? "";
      const contentId = (image.getAttribute("src") ?? "").replace(/^cid:/u, "");
      delete image.dataset.storedOwner;

      return { ownerId, contentId };
    }
  );
}

/** An image of saved rich content, shown from where it is stored. */
export const StoredImage = Node.create({
  name: "storedImage",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  selectable: true,

  // Each read from the saved `img` that storedImagesHtml prepared.
  addAttributes() {
    return {
      ownerId: {
        default: "",
        rendered: false,
        parseHTML: (element) => element.dataset.storedOwner ?? "",
      },
      contentId: {
        default: "",
        rendered: false,
        parseHTML: (element) =>
          (element.getAttribute("src") ?? "").replace(/^cid:/u, ""),
      },
      src: {
        default: "",
        rendered: false,
        parseHTML: (element) => element.dataset.src ?? "",
      },
      alt: {
        default: "",
        rendered: false,
        parseHTML: (element) => element.getAttribute("alt") ?? "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[data-stored-owner]" }];
  },

  // Serialized for sending: a `cid:` image, marked for takeStoredImages.
  renderHTML({ node, HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(HTMLAttributes, {
        src: `cid:${String(node.attrs.contentId)}`,
        alt: node.attrs.alt,
        title: node.attrs.alt,
        "data-stored-owner": node.attrs.ownerId,
      }),
    ];
  },

  renderText({ node }) {
    return String(node.attrs.alt);
  },

  // Shown in the editor from its stored copy.
  addNodeView() {
    return ({ node }) => {
      const image = document.createElement("img");
      image.className = "composer-inline-image";
      image.src = String(node.attrs.src);
      image.alt = String(node.attrs.alt);
      image.title = String(node.attrs.alt);
      image.draggable = false;

      return { dom: image };
    };
  },
});
