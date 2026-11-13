import { describe, expect, it } from "bun:test";

import { linkedAttachmentTextToken } from "@open-workspace/email/shared/mail.ts";
import { linkedAttachmentPlainText } from "@open-workspace/email/src/mail/composer-linked-attachment-text.ts";
import { generateText, Node } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

const LinkedAttachmentTextNode = Node.create({
  name: "linkedAttachment",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      uploadId: { default: null },
      filename: { default: "attachment" },
    };
  },
  renderText({ node }) {
    return linkedAttachmentPlainText(
      node.attrs.uploadId ? String(node.attrs.uploadId) : null,
      String(node.attrs.filename)
    );
  },
});

describe("composer plain-text serialization", () => {
  it("separates an inline attachment card from surrounding prose", () => {
    const uploadId = "upl_0123456789abcdef0123456789abcdef";

    const text = generateText(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Before" },
              {
                type: "linkedAttachment",
                attrs: {
                  localId: "local-attachment",
                  uploadId,
                  filename: "report.pdf",
                  size: 42,
                  status: "uploaded",
                },
              },
              { type: "text", text: "After" },
            ],
          },
        ],
      },
      [StarterKit, LinkedAttachmentTextNode]
    );

    expect(text).toBe(
      `Before\n\n${linkedAttachmentTextToken(uploadId)}\n\nAfter`
    );
  });
});
