import { workspaceIconPath } from "@open-workspace/core/shared";
import { useWorkspaceBrand } from "@open-workspace/core/ui";
import { useEffect } from "react";

import { useMailboxes } from "./use-mail-data";

/** The page's own favicon: the workspace's logo, or the OpenWorkspace icon. */
const DEFAULT_FAVICON = workspaceIconPath(64);

/** The OpenWorkspace icon with a dot; a workspace logo stays as it is, the title carries the count. */
const UNREAD_FAVICON = "/icons/app-icon-unread.svg";

function unreadLabel(count: number) {
  return count > 999 ? "999+" : String(count);
}

function updateAppBadge(count: number) {
  const operation =
    count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();

  void operation?.catch(() => {
    // Badging is optional and can be denied independently of notifications.
  });
}

export function UnreadDocumentIndicator() {
  const { name: title, logoUrl } = useWorkspaceBrand();
  const mailboxQuery = useMailboxes();
  let unreadCount = 0;

  for (const mailbox of mailboxQuery.data?.mailboxes ?? []) {
    unreadCount += mailbox.unreadCount;
  }

  useEffect(() => {
    document.title =
      unreadCount > 0 ? `(${unreadLabel(unreadCount)}) ${title}` : title;
    const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");

    if (favicon) {
      favicon.href =
        unreadCount > 0 && !logoUrl ? UNREAD_FAVICON : DEFAULT_FAVICON;
    }

    updateAppBadge(unreadCount);
  }, [unreadCount, title, logoUrl]);

  useEffect(
    () => () => {
      document.title = title;
      const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");

      if (favicon) favicon.href = DEFAULT_FAVICON;
      updateAppBadge(0);
    },
    [title]
  );

  return null;
}
