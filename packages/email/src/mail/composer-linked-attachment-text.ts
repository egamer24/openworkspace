import { linkedAttachmentTextToken } from "../../shared/mail";

export function linkedAttachmentPlainText(
  uploadId: string | null,
  filename: string
) {
  const text = uploadId ? linkedAttachmentTextToken(uploadId) : filename;

  // Tiptap concatenates inline serializers without separators. Keep the
  // plain-text alternative readable when a card sits between prose.
  return `\n\n${text}\n\n`;
}
