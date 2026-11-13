import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SessionsPanel } from "../components/sessions-panel";
import type { SessionRecord } from "../components/sessions-panel";
import { api, responseJson } from "../lib/api";
import { sessionQueryKeys } from "../lib/session-query-keys";

export function SessionsSettings() {
  const client = useQueryClient();

  const sessions = useQuery({
    queryKey: sessionQueryKeys.account,
    queryFn: async () => responseJson(await api.api.auth.sessions.$get()),
  });

  const revoke = useMutation({
    mutationFn: async (session: SessionRecord) =>
      responseJson(
        await api.api.auth.sessions[":id"].$delete({
          param: { id: session.id },
        })
      ),
    onSuccess: async (result) => {
      if (result.current) {
        window.location.replace("/");

        return;
      }

      toast.success("Session revoked");
      await client.invalidateQueries({ queryKey: sessionQueryKeys.account });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <SessionsPanel
      title="Where you're signed in"
      description="Revoke a session to sign that browser out."
      sessions={sessions.data?.sessions}
      loading={sessions.isLoading}
      error={sessions.isError}
      pendingSessionId={revoke.isPending ? revoke.variables?.id : undefined}
      onRetry={() => void sessions.refetch()}
      onRevoke={(session) => revoke.mutate(session)}
    />
  );
}
