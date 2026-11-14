import {
  Archive,
  Folder as FolderIcon,
  Inbox,
  NotebookPen,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { LucideProps } from "lucide-react";

import type { MailFolder } from "./types";

/** A folder's icon: its system folder's own, a plain folder for the rest. */
export function FolderGlyph({
  folder,
  ...props
}: LucideProps & { folder: MailFolder }) {
  if (folder.kind === "custom") return <FolderIcon {...props} />;

  switch (folder.systemType) {
    case "inbox": {
      return <Inbox {...props} />;
    }

    case "sent": {
      return <Send {...props} />;
    }

    case "drafts": {
      return <NotebookPen {...props} />;
    }

    case "archive": {
      return <Archive {...props} />;
    }

    case "spam": {
      return <ShieldAlert {...props} />;
    }

    case "trash": {
      return <Trash2 {...props} />;
    }

    // A folder without a system type.
    default: {
      return <FolderIcon {...props} />;
    }
  }
}
