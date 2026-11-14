/**
 * Rich content saved for later sending, such as a signature: HTML from the
 * composer's editor whose images are `cid:` references to objects in R2,
 * kept under an owner prefix for as long as the content exists.
 */

/** An image of saved rich content, sent inline under its content id. */
export type RichImage = {
  contentId: string;
  filename: string;
  contentType: string;
  size: number;
};

/** A reference, in a composed message, to an image of saved rich content. */
export type StoredImageRef = { ownerId: string; contentId: string };
