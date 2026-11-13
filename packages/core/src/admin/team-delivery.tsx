import { Inbox, Send } from "lucide-react";

import { listPostingCopy, listPostingPolicies } from "../../shared/workspace";
import type {
  ListPostingPolicy,
  MailboxDelivery,
} from "../../shared/workspace";
import { Label } from "../components/ui/label";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { AdminTeam, AdminUser } from "./types";

/** People on a team; an "everyone" team counts the active workspace. */
export function teamMemberCount(team: AdminTeam, users: AdminUser[]) {
  return team.everyone
    ? users.filter((user) => user.status === "active").length
    : team.members.length;
}

export function memberCountLabel(count: number) {
  return count === 1 ? "1 member" : `${count} members`;
}

const deliveryOptions: {
  value: MailboxDelivery;
  label: string;
  description: string;
  Icon: typeof Inbox;
}[] = [
  {
    value: "inbox",
    label: "Shared inbox",
    description: "One inbox the team opens together.",
    Icon: Inbox,
  },
  {
    value: "list",
    label: "Mailing list",
    description: "Each member gets a copy in their own mailbox.",
    Icon: Send,
  },
];

export function TeamDeliveryFields({
  idPrefix,
  delivery,
  listPosting,
  onDeliveryChange,
  onListPostingChange,
}: {
  idPrefix: string;
  delivery: MailboxDelivery;
  listPosting: ListPostingPolicy;
  onDeliveryChange: (delivery: MailboxDelivery) => void;
  onListPostingChange: (policy: ListPostingPolicy) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- labels the radio group through aria-labelledby */}
        <Label id={`${idPrefix}-delivery`}>Delivery</Label>
        <RadioGroup
          className="sm:grid-cols-2"
          aria-labelledby={`${idPrefix}-delivery`}
          value={delivery}
          onValueChange={(value: MailboxDelivery) => onDeliveryChange(value)}
        >
          {deliveryOptions.map(({ value, label, description, Icon }) => (
            <RadioCard
              key={value}
              value={value}
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
      {delivery === "list" ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-posting`}>Who can write to it</Label>
          <Select
            value={listPosting}
            onValueChange={(value) => onListPostingChange(value ?? "workspace")}
          >
            <SelectTrigger id={`${idPrefix}-posting`} className="w-full">
              <SelectValue>{listPostingCopy[listPosting].label}</SelectValue>
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
            {listPostingCopy[listPosting].description} Other senders get a
            bounce.
          </p>
        </div>
      ) : null}
    </div>
  );
}
