import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
  responseJson,
} from "@open-workspace/core/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, PenLine } from "lucide-react";

import { mailApi } from "../lib/mail-api";
import { mailboxesQuery } from "../mail/mail-queries";
import { SignatureEditor } from "./signature-editor";
import type { SignatureBody } from "./signature-editor";

export function SignatureSettings() {
  const client = useQueryClient();
  const mailboxes = useQuery(mailboxesQuery());

  // Read once per visit: the editor keeps its own state after loading it.
  const saved = useQuery({
    queryKey: ["signature"],
    queryFn: async () => responseJson(await mailApi.api.mail.signature.$get()),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });

  const uploadMailbox = mailboxes.data?.mailboxes.find(
    (mailbox) => mailbox.kind === "personal" && mailbox.canSend
  );

  async function save(body: SignatureBody) {
    await responseJson(await mailApi.api.mail.signature.$put({ json: body }));
    await client.invalidateQueries({ queryKey: mailboxesQuery().queryKey });
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={PenLine}
        title="Signature"
        description="Added to messages you send from your own mailboxes. Shared inboxes use the signature their team sets."
      />
      <AdminPanelBody>
        {saved.isPending || mailboxes.isPending ? (
          <div className="text-muted-foreground flex items-center gap-2 py-5 text-sm">
            <LoaderCircle className="size-4 animate-spin" /> Loading signature…
          </div>
        ) : saved.isError ? (
          <p className="text-destructive py-4 text-sm">
            Your signature couldn't be loaded.
          </p>
        ) : (
          <SignatureEditor
            saved={saved.data.signature}
            uploadMailboxId={uploadMailbox?.id}
            label="Your signature"
            placeholder="Your name, role, phone…"
            onSave={save}
          />
        )}
      </AdminPanelBody>
    </div>
  );
}
