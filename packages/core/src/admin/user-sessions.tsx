import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SessionsPanel } from "../components/sessions-panel";
import type { SessionRecord } from "../components/sessions-panel";
import { api, responseJson } from "../lib/api";
import { sessionQueryKeys } from "../lib/session-query-keys";

export function AdminUserSessions({ userId }: { userId: string }) {
  const client = useQueryClient();
  const queryKey = sessionQueryKeys.adminUser(userId);

  const sessions = useQuery({
    queryKey,
    queryFn: async () =>
      responseJson(
        await api.api.admin.users[":userId"].sessions.$get({
          param: { userId },
        })
      ),
  });

  const revoke = useMutation({
    mutationFn: async ({
      userId: targetUserId,
      session,
    }: {
      userId: string;
      session: SessionRecord;
    }) =>
      responseJson(
        await api.api.admin.users[":userId"].sessions[":sessionId"].$delete({
          param: { userId: targetUserId, sessionId: session.id },
        })
      ),
    onSuccess: async (result, variables) => {
      if (result.current) {
        window.location.replace("/");

        return;
      }

      toast.success("Session revoked");
      await client.invalidateQueries({
        queryKey: sessionQueryKeys.adminUser(variables.userId),
      });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <SessionsPanel
      title="User sessions"
      sessions={sessions.data?.sessions}
      loading={sessions.isLoading}
      error={sessions.isError}
      pendingSessionId={
        revoke.isPending && revoke.variables?.userId === userId
          ? revoke.variables.session.id
          : undefined
      }
      onRetry={() => void sessions.refetch()}
      onRevoke={(session) => revoke.mutate({ userId, session })}
    />
  );
}
