import { mailApi } from "../lib/mail-api";
import type { ComposerSession } from "./composer-session";

/** Resolves once none of `assetIds` is still uploading (or the session closed). */
async function uploadsSettled(session: ComposerSession, assetIds: string[]) {
  const settled = () => {
    const snapshot = session.getSnapshot();

    return (
      snapshot.phase === "closed" ||
      !snapshot.assets.some(
        (asset) => assetIds.includes(asset.id) && asset.status === "uploading"
      )
    );
  };

  if (settled()) return;

  await new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe(() => {
      if (!settled()) return;
      unsubscribe();
      resolve();
    });
  });
}

/**
 * A saved signature as editor content: each `cid:` image is fetched and
 * uploaded again into `session`, so it is an ordinary composer inline image
 * (sent, or deleted, like any other). Resolves once those uploads finish, so
 * the signature never lands without its images.
 */
export async function signatureEditorHtml(
  session: ComposerSession,
  ownerId: string,
  html: string
) {
  const document = new DOMParser().parseFromString(html, "text/html");

  const images = [...document.querySelectorAll("img")].flatMap((image) => {
    const source = image.getAttribute("src") ?? "";

    if (source.startsWith("cid:")) {
      return [{ image, contentId: source.slice(4) }];
    }

    image.remove();

    return [];
  });

  const files = await Promise.all(
    images.map(async ({ image, contentId }) => {
      const response = await mailApi.api.mail["signature-images"][":ownerId"][
        ":contentId"
      ].$get({ param: { ownerId, contentId } });

      if (!response.ok) return null;
      const blob = await response.blob();

      return new File([blob], image.alt || "image", { type: blob.type });
    })
  );

  const restored = images.flatMap(({ image }, index) => {
    const file = files[index];

    if (file) return [{ image, file }];
    image.remove();

    return [];
  });

  const assets = restored.length
    ? (session.addFiles(
        restored.map(({ file }) => file),
        "inline"
      ) ?? [])
    : [];

  for (const [index, { image }] of restored.entries()) {
    const asset = assets[index];

    if (!asset) {
      image.remove();
      continue;
    }

    const node = document.createElement("span");
    node.dataset.composerAsset = asset.id;
    node.dataset.composerAssetIntent = "inline";
    image.replaceWith(node);
  }

  await uploadsSettled(
    session,
    assets.map((asset) => asset.id)
  );

  return document.body.innerHTML;
}
