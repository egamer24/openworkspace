import { Badge, Skeleton, responseJson } from "@open-workspace/core/ui";
import type { TeamAddress, UserAddress } from "@open-workspace/core/ui";
import { useQuery } from "@tanstack/react-query";

import { mailApi } from "../lib/mail-api";

/**
 * A forward's destinations in the address editor (People or Teams), each
 * Confirmed or Waiting for confirmation: Cloudflare forwards to one only
 * after it followed the link in Cloudflare's email. Nothing to save here;
 * saving the address adds new destinations (worker/mail/forward-destinations.ts).
 */
export function ForwardDestinations({
  address,
}: {
  address: TeamAddress | UserAddress;
}) {
  if (address.delivery !== "forward" || !address.forwardTo.length) return null;

  return (
    <DestinationList
      mailboxId={address.mailboxId}
      forwardTo={address.forwardTo}
    />
  );
}

function DestinationList({
  mailboxId,
  forwardTo,
}: {
  mailboxId: string;
  /** As the form has them, saved or not. */
  forwardTo: string[];
}) {
  const saved = useQuery({
    queryKey: ["forward-destinations", mailboxId],
    queryFn: async () =>
      responseJson(
        await mailApi.api.mail["forward-destinations"][":mailboxId"].$get({
          param: { mailboxId },
        })
      ),
  });

  const confirmed = new Map(
    (saved.data?.destinations ?? []).map((destination) => [
      destination.email.toLowerCase(),
      destination.confirmed,
    ])
  );

  return (
    <div className="space-y-2">
      <p className="text-foreground/85 text-[0.8125rem] font-semibold">
        Forward destinations
      </p>
      <ul className="divide-border/60 ring-border divide-y overflow-hidden rounded-xl ring-1">
        {forwardTo.map((email) => {
          const status = confirmed.get(email);

          return (
            <li key={email} className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                {email}
              </span>
              {saved.isPending ? (
                <Skeleton className="h-5 w-24" />
              ) : status === undefined ? (
                <span className="text-muted-foreground text-xs">
                  Gets a confirmation email when you save
                </span>
              ) : status ? (
                <Badge variant="success">Confirmed</Badge>
              ) : (
                <Badge variant="warning">Waiting for confirmation</Badge>
              )}
            </li>
          );
        })}
      </ul>
      {saved.isError ? (
        <p className="text-destructive text-xs">
          Couldn't check these with Cloudflare: {saved.error.message}
        </p>
      ) : saved.data && !saved.data.connected ? (
        <p className="text-muted-foreground text-xs">
          Email Routing isn't connected here (local development), so
          confirmations can't be checked and nothing is forwarded.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          Mail goes only to confirmed destinations. Each new one gets an email
          from Cloudflare with a link to confirm it.
        </p>
      )}
    </div>
  );
}
