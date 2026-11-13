import { useMutation } from "@tanstack/react-query";
import { FileUp, LoaderCircle, Wand2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import type { SamlNameIdFormat } from "../../shared/saml";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { api, responseJson } from "../lib/api";
import { Field, SwitchRow } from "./sso-app-fields";
import { microsoftSamlAttributes, simpleSamlAttributes } from "./sso-app-model";
import type { SamlAppInput } from "./sso-app-model";
import type { SamlMetadataDraft } from "./types";

const nameIdLabels: Record<SamlNameIdFormat, string> = {
  email: "Email address",
  persistent: "A fixed ID that never changes",
};

/** Where the app sends people back after sign-in, and how it names them. */
export function SamlConnectionFields({
  input,
  disabled,
  onChange,
}: {
  input: SamlAppInput;
  disabled?: boolean;
  onChange: (patch: Partial<SamlAppInput>) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-4" disabled={disabled}>
      <Field
        id="saml-entity-id"
        label="App's entity ID"
        help="The app's own SAML name, shown on its SSO settings page. Also called the audience, audience URI, SP entity ID, identifier, or issuer. Usually a URL, sometimes a name like urn:amazon:webservices."
      >
        <Input
          id="saml-entity-id"
          className="font-mono text-xs"
          value={input.entityId}
          disabled={disabled}
          placeholder="https://app.example.com/saml/metadata"
          onChange={(event) => onChange({ entityId: event.target.value })}
        />
      </Field>
      <Field
        id="saml-acs-url"
        label="App's ACS URL"
        help="Where the app receives the signed sign-in answer. Also called the ACS (Assertion Consumer Service) URL, reply URL, single sign-on URL, recipient URL, or callback URL."
      >
        <Input
          id="saml-acs-url"
          className="font-mono text-xs"
          type="url"
          value={input.acsUrl}
          disabled={disabled}
          placeholder="https://app.example.com/saml/acs"
          onChange={(event) => onChange({ acsUrl: event.target.value })}
        />
      </Field>
      <div className="space-y-2">
        <Label htmlFor="saml-name-id-format">
          How the app identifies people
        </Label>
        <Select
          value={input.nameIdFormat}
          disabled={disabled}
          onValueChange={(nameIdFormat) => {
            if (nameIdFormat) onChange({ nameIdFormat });
          }}
        >
          <SelectTrigger id="saml-name-id-format" className="w-full">
            <SelectValue>{nameIdLabels[input.nameIdFormat]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="email">{nameIdLabels.email}</SelectItem>
            <SelectItem value="persistent">
              {nameIdLabels.persistent}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs leading-5">
          Sent as the NameID. Pick a fixed ID when the app says "persistent", so
          a changed email address does not create a new account.
        </p>
      </div>
    </fieldset>
  );
}

/** "Paste the app's metadata URL or upload its XML", filling the form from it. */
export function SamlMetadataImport({
  onImported,
}: {
  onImported: (draft: SamlMetadataDraft) => void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");

  const parse = useMutation({
    mutationFn: async (json: { url: string } | { xml: string }) =>
      responseJson(
        await api.api.admin["saml-applications"]["parse-metadata"].$post({
          json,
        })
      ),
    onSuccess: ({ draft }) => {
      onImported(draft);
      toast.success("Filled in from the app's metadata");

      for (const warning of draft.warnings) toast.warning(warning);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="bg-surface-sunken/50 ring-border space-y-3 rounded-xl p-4 ring-1">
      <div>
        <p className="text-[0.8125rem] font-semibold">
          Paste the app's metadata URL or upload its XML
        </p>
        <p className="text-muted-foreground text-xs leading-5">
          Most apps offer a metadata link or file on their SSO settings page (SP
          metadata or service provider metadata). It fills in the fields below;
          or type them in by hand.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Label htmlFor={`${id}-url`} className="sr-only">
          Metadata URL
        </Label>
        <Input
          id={`${id}-url`}
          type="url"
          className="font-mono text-xs"
          placeholder="https://app.example.com/saml/metadata"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={parse.isPending || !url.trim()}
            onClick={() => parse.mutate({ url: url.trim() })}
          >
            {parse.isPending ? <LoaderCircle className="animate-spin" /> : null}
            Read
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={parse.isPending}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp /> Upload XML
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".xml,application/xml,text/xml,application/samlmetadata+xml"
          className="hidden"
          aria-label="Metadata XML file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";

            if (!file) return;

            if (file.size > 512 * 1024) {
              toast.error("The metadata file is larger than 512 KB");

              return;
            }

            void file.text().then((xml) => parse.mutate({ xml }));
          }}
        />
      </div>
    </div>
  );
}

export function samlInputFromMetadata(
  input: SamlAppInput,
  draft: SamlMetadataDraft
): SamlAppInput {
  return {
    ...input,
    name: input.name || draft.name || "",
    entityId: draft.entityId,
    acsUrl: draft.acsUrl,
    nameIdFormat: draft.nameIdFormat ?? input.nameIdFormat,
    requireSignedAuthnRequests: draft.requireSignedAuthnRequests,
    spSigningCertificate:
      draft.spSigningCertificate ?? input.spSigningCertificate,
  };
}

function AttributeInput({
  id,
  label,
  help,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label} help={help}>
      <Input
        id={id}
        className="font-mono text-xs"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** Renames the attributes, sending teams only if they were being sent. */
function attributeStyle(
  names: typeof simpleSamlAttributes,
  groupsAttributeName: string
) {
  return {
    ...names,
    groupsAttributeName: groupsAttributeName.trim()
      ? names.groupsAttributeName
      : "",
  };
}

export function SamlAdvancedFields({
  input,
  launchUrl,
  disabled,
  onChange,
}: {
  input: SamlAppInput;
  launchUrl?: string | null;
  disabled?: boolean;
  onChange: (patch: Partial<SamlAppInput>) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-5" disabled={disabled}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-foreground/85 text-[0.8125rem] font-semibold">
              Attribute names
            </p>
            <p className="text-muted-foreground text-xs leading-5">
              The names the app reads each detail from. Copy them from the app's
              instructions.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                onChange(
                  attributeStyle(
                    simpleSamlAttributes,
                    input.groupsAttributeName
                  )
                )
              }
            >
              Use simple names
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                onChange(
                  attributeStyle(
                    microsoftSamlAttributes,
                    input.groupsAttributeName
                  )
                )
              }
            >
              <Wand2 /> Use Microsoft-style names
            </Button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <AttributeInput
            id="saml-email-attribute"
            label="Email address"
            help="Required."
            value={input.emailAttributeName}
            disabled={disabled}
            onChange={(emailAttributeName) => onChange({ emailAttributeName })}
          />
          <AttributeInput
            id="saml-name-attribute"
            label="Full name"
            help="Required."
            value={input.nameAttributeName}
            disabled={disabled}
            onChange={(nameAttributeName) => onChange({ nameAttributeName })}
          />
          <AttributeInput
            id="saml-first-name-attribute"
            label="First name"
            help="Optional. Everything but the last word of the name."
            value={input.firstNameAttributeName}
            disabled={disabled}
            onChange={(firstNameAttributeName) =>
              onChange({ firstNameAttributeName })
            }
          />
          <AttributeInput
            id="saml-last-name-attribute"
            label="Last name"
            help="Optional. The last word of the name."
            value={input.lastNameAttributeName}
            disabled={disabled}
            onChange={(lastNameAttributeName) =>
              onChange({ lastNameAttributeName })
            }
          />
          <AttributeInput
            id="saml-groups-attribute"
            label="Teams"
            help="Carries which of the teams with access each person is in. Leave empty to send none."
            value={input.groupsAttributeName}
            disabled={disabled}
            onChange={(groupsAttributeName) =>
              onChange({ groupsAttributeName })
            }
          />
        </div>
      </div>

      <div className="divide-border/60 border-border/70 divide-y border-y">
        <SwitchRow
          label="Sign the whole response"
          description="The sign-in answer is always signed inside; this signs its outer envelope too. Most apps accept both."
          checked={input.signResponse}
          disabled={disabled}
          onCheckedChange={(signResponse) => onChange({ signResponse })}
        />
        <SwitchRow
          label="Start sign-in from here"
          description="Lets people open the app signed in from a link on this side (IdP-initiated sign-in). Turn off if the app's instructions say so."
          checked={input.allowIdpInitiated}
          disabled={disabled}
          onCheckedChange={(allowIdpInitiated) =>
            onChange({ allowIdpInitiated })
          }
        />
        <SwitchRow
          label="Only accept signed requests from the app"
          description="Checks the app's signature on every sign-in request. Needs the app's signing certificate."
          checked={input.requireSignedAuthnRequests}
          disabled={disabled}
          onCheckedChange={(requireSignedAuthnRequests) =>
            onChange({ requireSignedAuthnRequests })
          }
        />
      </div>

      {input.requireSignedAuthnRequests ? (
        <Field
          id="saml-sp-certificate"
          label="App's signing certificate"
          help="The app's public certificate, starting with -----BEGIN CERTIFICATE-----."
        >
          <Textarea
            id="saml-sp-certificate"
            className="min-h-32 font-mono text-[11px]"
            value={input.spSigningCertificate}
            disabled={disabled}
            placeholder="-----BEGIN CERTIFICATE-----"
            onChange={(event) =>
              onChange({ spSigningCertificate: event.target.value })
            }
          />
        </Field>
      ) : null}

      {input.allowIdpInitiated && launchUrl ? (
        <Field
          id="saml-launch-url"
          label="Sign-in link"
          help="Put this on an intranet page or app launcher; it opens the app signed in."
        >
          <Input
            id="saml-launch-url"
            readOnly
            className="font-mono text-xs"
            value={launchUrl}
          />
        </Field>
      ) : null}
    </fieldset>
  );
}
