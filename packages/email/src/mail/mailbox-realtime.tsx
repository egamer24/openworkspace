import { noteD1Bookmark, useAuth } from "@open-workspace/core/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { parseMailboxRealtimeUpdate } from "../../shared/mail";
import { noteMailboxVersion, watchMailboxVersions } from "./mail-query-cache";
import { useMailboxes } from "./use-mail-data";

type MailboxConnection = {
  socket: WebSocket | null;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

const PRESENCE_HEARTBEAT_MS = 25_000;

function realtimeUrl(mailboxId: string, visibility: "visible" | "hidden") {
  const url = new URL(
    `/api/mail/mailboxes/${encodeURIComponent(mailboxId)}/realtime`,
    window.location.origin
  );

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("visibility", visibility);

  return url;
}

function mailboxFromPath(pathname: string, mailboxIds: string[]) {
  if (pathname === "/") return mailboxIds[0] ?? null;
  const match = /^\/mail\/([^/]+)\/?$/u.exec(pathname);

  const encoded = match?.[1];

  if (encoded === undefined) return null;

  try {
    const mailboxId = decodeURIComponent(encoded);

    return mailboxIds.includes(mailboxId) ? mailboxId : null;
  } catch {
    return null;
  }
}

export function MailboxRealtimeConnections() {
  const auth = useAuth();
  const client = useQueryClient();
  const location = useLocation();
  const mailboxQuery = useMailboxes();

  const mailboxIds =
    mailboxQuery.data?.mailboxes.map((mailbox) => mailbox.id) ?? [];

  const mailboxKey = mailboxIds.join("\0");
  const userId = auth.user?.id;
  const { sessionVersion } = auth;
  const activeMailboxId = mailboxFromPath(location.pathname, mailboxIds);

  useEffect(() => watchMailboxVersions(client), [client]);

  if (!userId || !mailboxKey) return null;

  // A new session (another person, or signing in again) opens new sockets.
  return (
    <MailboxSockets
      key={`${userId}\0${sessionVersion ?? ""}`}
      mailboxKey={mailboxKey}
      activeMailboxId={activeMailboxId}
    />
  );
}

/** One socket per mailbox in `mailboxKey`, telling each whether it is on screen. */
function MailboxSockets({
  mailboxKey,
  activeMailboxId,
}: {
  mailboxKey: string;
  activeMailboxId: string | null;
}) {
  const client = useQueryClient();
  const activeMailboxRef = useRef<string | null>(activeMailboxId);
  const sendPresenceRef = useRef<(() => void) | null>(null);
  // Before the connection effect, so sockets opened in the same commit
  // announce the current mailbox; later changes are announced at once.
  useEffect(() => {
    activeMailboxRef.current = activeMailboxId;
    sendPresenceRef.current?.();
  }, [activeMailboxId]);

  useEffect(() => {
    const ids = mailboxKey.split("\0");
    const connections = new Map<string, MailboxConnection>();
    let stopped = false;
    let ownershipRefresh: Promise<void> | null = null;

    function refreshOwnership() {
      if (!ownershipRefresh) {
        ownershipRefresh = Promise.all([
          client.invalidateQueries({ queryKey: ["auth-state"] }),
          client.invalidateQueries({ queryKey: ["mailboxes"] }),
        ])
          .then(() => undefined)
          .catch((error) => {
            console.error(
              "Could not refresh realtime connection ownership",
              error
            );
          })
          .finally(() => {
            ownershipRefresh = null;
          });
      }

      return ownershipRefresh;
    }

    function visibilityFor(mailboxId: string) {
      return document.visibilityState === "visible" &&
        activeMailboxRef.current === mailboxId
        ? ("visible" as const)
        : ("hidden" as const);
    }

    function sendMailboxPresence(mailboxId: string) {
      const connection = connections.get(mailboxId);

      if (connection?.socket?.readyState === WebSocket.OPEN) {
        connection.socket.send(visibilityFor(mailboxId));
      }
    }

    function sendPresence() {
      for (const mailboxId of connections.keys()) {
        sendMailboxPresence(mailboxId);
      }
    }

    sendPresenceRef.current = sendPresence;

    function connect(mailboxId: string) {
      const connection = connections.get(mailboxId);

      if (!connection || stopped || !navigator.onLine) return;

      if (
        connection.socket?.readyState === WebSocket.OPEN ||
        connection.socket?.readyState === WebSocket.CONNECTING
      ) {
        return;
      }

      const socket = new WebSocket(
        realtimeUrl(mailboxId, visibilityFor(mailboxId))
      );

      let opened = false;
      connection.socket = socket;
      socket.addEventListener("open", () => {
        if (stopped || connection.socket !== socket) return;
        opened = true;
        connection.retryAttempt = 0;
        sendMailboxPresence(mailboxId);
      });
      // The server announces the mailbox's version on open (covering changes
      // made before this socket existed, e.g. while reconnecting) and after
      // each change; only data older than it is refetched.
      socket.addEventListener("message", (message) => {
        if (stopped || connection.socket !== socket) return;
        const update = parseMailboxRealtimeUpdate(message.data);

        if (!update) return;
        // First, so the refetches below read D1 at least as new as the change.
        noteD1Bookmark(update.bookmark);
        noteMailboxVersion(client, mailboxId, update.version);
      });
      socket.addEventListener("close", (event) => {
        if (connection.socket === socket) connection.socket = null;

        if (stopped || event.code === 1000) return;

        if (event.code === 1008) {
          void refreshOwnership();

          return;
        }

        const delay = Math.min(30_000, 500 * 2 ** connection.retryAttempt);
        connection.retryAttempt += 1;
        connection.retryTimer = setTimeout(
          () => {
            connection.retryTimer = null;
            void (async () => {
              // Browsers expose a rejected WebSocket handshake as an abnormal
              // close, so refresh access before retrying a socket that never opened.
              if (!opened && navigator.onLine) await refreshOwnership();
              connect(mailboxId);
            })();
          },
          delay + Math.floor(Math.random() * Math.min(delay, 1000))
        );
      });
    }

    for (const mailboxId of ids) {
      connections.set(mailboxId, {
        socket: null,
        retryAttempt: 0,
        retryTimer: null,
      });
      connect(mailboxId);
    }

    const reconnect = () => {
      for (const mailboxId of ids) connect(mailboxId);
    };

    document.addEventListener("visibilitychange", sendPresence);
    window.addEventListener("online", reconnect);

    const heartbeat = () => {
      const mailboxId = activeMailboxRef.current;

      if (document.visibilityState === "visible" && mailboxId) {
        sendMailboxPresence(mailboxId);
      }
    };

    const presenceTimer = window.setInterval(heartbeat, PRESENCE_HEARTBEAT_MS);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", sendPresence);
      window.removeEventListener("online", reconnect);
      window.clearInterval(presenceTimer);

      if (sendPresenceRef.current === sendPresence) {
        sendPresenceRef.current = null;
      }

      for (const connection of connections.values()) {
        if (connection.retryTimer) clearTimeout(connection.retryTimer);
        connection.socket?.close(1000, "Client disconnected");
      }
    };
  }, [client, mailboxKey]);

  return null;
}
