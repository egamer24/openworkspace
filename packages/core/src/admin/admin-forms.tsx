import { LoaderCircle, UserPlus } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import {
  DomainAddressInput,
  useDomainAddress,
} from "../components/domain-address-input";
import { Button } from "../components/ui/button";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import type { InvitationInput } from "./types";

export function InviteForm({
  pending,
  domains,
  onSubmit,
}: {
  pending: boolean;
  /** Mail domains new addresses may use, primary first. */
  domains: readonly string[];
  onSubmit: (input: InvitationInput) => void;
}) {
  const [name, setName] = useState("");

  const email = useDomainAddress(domains);

  function submit(event: FormEvent) {
    event.preventDefault();

    if (email.address) onSubmit({ name, email: email.address });
  }

  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelHeader
        Icon={UserPlus}
        title="Invite a person"
        description="They receive a one-time link to register a passkey."
      />
      <AdminPanelBody>
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel className="sr-only" htmlFor="invite-name">
              Name
            </FieldLabel>
            <Input
              id="invite-name"
              placeholder="Full name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel className="sr-only" htmlFor="invite-email">
              Personal mailbox
            </FieldLabel>
            <DomainAddressInput
              id="invite-email"
              field={email}
              placeholder="name"
              required
            />
          </Field>
        </FieldGroup>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button type="submit" disabled={pending || !email.address}>
          {pending ? <LoaderCircle className="animate-spin" /> : <UserPlus />}
          Invite
        </Button>
      </AdminPanelFooter>
    </form>
  );
}
