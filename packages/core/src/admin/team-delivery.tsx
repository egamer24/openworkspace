import { Forward, Inbox, Mail, Send, Shuffle } from "lucide-react";

import { listPostingCopy, listPostingPolicies } from "../../shared/workspace";
import type {
  ListPostingPolicy,
  MailboxDelivery,
} from "../../shared/workspace";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import type { AdminMailbox, AdminTeam, AdminUser } from "./types";

/** People on a team; an "everyone" team counts the active workspace. */
export function teamMemberCount(team: AdminTeam, users: AdminUser[]) {
  return team.everyone
    ? users.filter((user) => user.status === "active").length
    : team.members.length;
}

export function memberCountLabel(count: number) {
  return count === 1 ? "1 member" : `${count} members`;
}

/** What an address editor holds about delivery; `forwardTo` as typed. */
export type DeliveryForm = {
  delivery: MailboxDelivery;
  listPosting: ListPostingPolicy;
  aliasOf: string | null;
  forwardTo: string;
  catchAll: boolean;
};

export function deliveryForm(mailbox?: AdminMailbox): DeliveryForm {
  return {
    delivery: mailbox?.delivery ?? "inbox",
    listPosting: mailbox?.listPosting ?? "workspace",
    aliasOf: mailbox?.aliasOf ?? null,
    forwardTo: mailbox?.forwardTo?.join(", ") ?? "",
    catchAll: mailbox?.catchAll ?? false,
  };
}

/** The typed forward destinations, one per comma, space or line. */
export function forwardDestinations(text: string) {
  return text
    .split(/[\s,;]+/u)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** What the admin API stores for the form: only the fields its delivery uses. */
export function deliveryInput(form: DeliveryForm) {
  return {
    delivery: form.delivery,
    listPosting: form.listPosting,
    aliasOf: form.delivery === "alias" ? form.aliasOf : null,
    forwardTo:
      form.delivery === "forward" ? forwardDestinations(form.forwardTo) : null,
    catchAll: form.delivery === "inbox" && form.catchAll,
  };
}

/** Whether the form differs from what `mailbox` stores. */
export function deliveryChanged(form: DeliveryForm, mailbox: AdminMailbox) {
  const input = deliveryInput(form);

  return (
    input.delivery !== mailbox.delivery ||
    input.listPosting !== mailbox.listPosting ||
    input.aliasOf !== mailbox.aliasOf ||
    (input.forwardTo ?? []).join(",") !== (mailbox.forwardTo ?? []).join(",") ||
    input.catchAll !== mailbox.catchAll
  );
}

/** Whether the form can be saved as it is. */
export function deliveryComplete(form: DeliveryForm) {
  if (form.delivery === "alias") return Boolean(form.aliasOf);

  if (form.delivery === "forward") {
    return forwardDestinations(form.forwardTo).length > 0;
  }

  return true;
}

/** Short words for an address's delivery, as address lists show it. */
export function deliveryLabel(
  mailbox: AdminMailbox,
  mailboxes: readonly AdminMailbox[]
) {
  switch (mailbox.delivery) {
    case "list": {
      return `Mailing list · ${listPostingCopy[mailbox.listPosting].label} can write`;
    }

    case "alias": {
      const target = mailboxes.find((other) => other.id === mailbox.aliasOf);

      return `Alias of ${target?.address ?? "another address"}`;
    }

    case "forward": {
      return `Forwards to ${(mailbox.forwardTo ?? []).join(", ")}`;
    }

    default: {
      return mailbox.catchAll
        ? `${mailbox.displayName} · catch-all for @${mailbox.domain}`
        : mailbox.displayName;
    }
  }
}

export const deliveryBadge: Record<MailboxDelivery, string> = {
  inbox: "Inbox",
  list: "Mailing list",
  alias: "Alias",
  forward: "Forward",
};

const deliveryIcons: Record<MailboxDelivery, typeof Inbox> = {
  inbox: Inbox,
  list: Send,
  alias: Shuffle,
  forward: Forward,
};

export function DeliveryIcon({ delivery }: { delivery: MailboxDelivery }) {
  const Icon = deliveryIcons[delivery];

  return <Icon className="text-muted-foreground size-4 shrink-0" />;
}

const deliveryCopy: Record<
  "team" | "person",
  Partial<
    Record<
      MailboxDelivery,
      { label: string; description: string; Icon: typeof Inbox }
    >
  >
> = {
  team: {
    inbox: {
      label: "Shared inbox",
      description: "One inbox the team opens together.",
      Icon: Inbox,
    },
    list: {
      label: "Mailing list",
      description: "Each member gets a copy in their own mailbox.",
      Icon: Send,
    },
    alias: {
      label: "Alias",
      description: "Delivers into another of the team's addresses.",
      Icon: Shuffle,
    },
    forward: {
      label: "Forward",
      description: "Sends mail on to outside addresses.",
      Icon: Forward,
    },
  },
  person: {
    inbox: {
      label: "Own mailbox",
      description: "A mailbox of its own.",
      Icon: Mail,
    },
    alias: {
      label: "Alias",
      description: "Delivers into another of their mailboxes.",
      Icon: Shuffle,
    },
    forward: {
      label: "Forward",
      description: "Sends mail on to outside addresses.",
      Icon: Forward,
    },
  },
};

/**
 * How an address delivers, for a team's address or a person's: its own
 * mailbox (optionally its domain's catch-all), a mailing list (teams), an
 * alias of another of the same team's or person's addresses, or a forward.
 */
export function DeliveryFields({
  idPrefix,
  owner,
  value,
  onChange,
  aliasTargets,
  domain,
  fixed = false,
}: {
  idPrefix: string;
  owner: "team" | "person";
  value: DeliveryForm;
  onChange: (value: DeliveryForm) => void;
  /** Addresses an alias may deliver into: the same team's or person's. */
  aliasTargets: readonly AdminMailbox[];
  /** The address's domain, for the catch-all. */
  domain: string;
  /** A primary address keeps its own mailbox; only the catch-all changes. */
  fixed?: boolean;
}) {
  const update = (patch: Partial<DeliveryForm>) =>
    onChange({ ...value, ...patch });

  const options = Object.entries(deliveryCopy[owner]).flatMap(
    ([delivery, copy]) => {
      if (!copy) return [];

      // SAFETY: deliveryCopy's keys are MailboxDelivery values.
      return [{ value: delivery as MailboxDelivery, ...copy }];
    }
  );

  const target = aliasTargets.find((mailbox) => mailbox.id === value.aliasOf);

  return (
    <div className="space-y-4">
      {fixed ? null : (
        <div className="space-y-2">
          {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- labels the radio group through aria-labelledby */}
          <Label id={`${idPrefix}-delivery`}>Delivery</Label>
          <RadioGroup
            className="sm:grid-cols-2"
            aria-labelledby={`${idPrefix}-delivery`}
            value={value.delivery}
            onValueChange={(delivery: MailboxDelivery) => update({ delivery })}
          >
            {options.map(({ value: option, label, description, Icon }) => (
              <RadioCard
                key={option}
                value={option}
                indicator={false}
                className="rounded-xl"
              >
                <Icon className="text-muted-foreground group-data-checked/radio-card:text-primary mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-[0.8125rem] font-semibold">
                    {label}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {description}
                  </span>
                </span>
              </RadioCard>
            ))}
          </RadioGroup>
        </div>
      )}
      {value.delivery === "list" ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-posting`}>Who can write to it</Label>
          <Select
            value={value.listPosting}
            onValueChange={(listPosting) =>
              update({ listPosting: listPosting ?? "workspace" })
            }
          >
            <SelectTrigger id={`${idPrefix}-posting`} className="w-full">
              <SelectValue>
                {listPostingCopy[value.listPosting].label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {listPostingPolicies.map((policy) => (
                <SelectItem key={policy} value={policy}>
                  {listPostingCopy[policy].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {listPostingCopy[value.listPosting].description} Other senders get a
            bounce.
          </p>
        </div>
      ) : null}
      {value.delivery === "alias" ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-alias-of`}>Delivers into</Label>
          <Select
            value={value.aliasOf ?? ""}
            onValueChange={(aliasOf) => update({ aliasOf: aliasOf || null })}
          >
            <SelectTrigger id={`${idPrefix}-alias-of`} className="w-full">
              <SelectValue>
                {target?.address ?? "Choose an address"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {aliasTargets.map((mailbox) => (
                <SelectItem key={mailbox.id} value={mailbox.id}>
                  {mailbox.address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Replies to mail sent here come from this address.
          </p>
        </div>
      ) : null}
      {value.delivery === "forward" ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-forward-to`}>Forward to</Label>
          <Input
            id={`${idPrefix}-forward-to`}
            value={value.forwardTo}
            placeholder="name@example.com, other@example.com"
            onChange={(event) => update({ forwardTo: event.target.value })}
          />
          <p className="text-muted-foreground text-xs">
            Up to five outside addresses. Each gets an email to confirm it, and
            mail goes to it only once it's confirmed.
          </p>
        </div>
      ) : null}
      {value.delivery === "inbox" && domain ? (
        <label className="bg-surface-sunken/50 ring-border flex items-center justify-between gap-4 rounded-xl px-3.5 py-3 ring-1">
          <span className="min-w-0">
            <span className="block text-[0.8125rem] font-semibold">
              Catch-all for @{domain}
            </span>
            <span className="text-muted-foreground block text-xs">
              Also gets mail sent to addresses on {domain} that don't exist.
            </span>
          </span>
          <Switch
            checked={value.catchAll}
            onCheckedChange={(catchAll) => update({ catchAll })}
          />
        </label>
      ) : null}
    </div>
  );
}
