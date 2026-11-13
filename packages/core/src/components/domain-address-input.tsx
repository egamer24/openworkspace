import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import {
  completesListedDomain,
  resolveDomainAddress,
  settleAddressText,
  splitAddressText,
} from "../lib/domain-address";
import type { DomainAddressState } from "../lib/domain-address";
import { cn } from "../lib/utils";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

/**
 * The state of an address field on the workspace's mail domains (primary first):
 * pass it to `DomainAddressInput`, and submit its `address`, which is null
 * until the field holds a usable one.
 */
export function useDomainAddress(domains: readonly string[]) {
  const [state, setState] = useState<DomainAddressState>({
    text: "",
    domain: "",
    rejectedDomain: null,
  });

  // Domains can arrive after the field mounts; an unknown pick falls back to the primary.
  const domain = domains.includes(state.domain)
    ? state.domain
    : (domains[0] ?? "");

  const current = { ...state, domain };
  const resolved = resolveDomainAddress(current, domains);

  return {
    ...current,
    ...resolved,
    domains,
    /** Typing keeps the text as is; a paste, autofill or drop settles a full address at once. */
    change(value: string, settle: boolean) {
      setState(
        settle || completesListedDomain(value, domains)
          ? settleAddressText(current, value, domains)
          : { ...current, text: value, rejectedDomain: null }
      );
    },
    settle() {
      if (splitAddressText(current.text).domain !== null) {
        setState(settleAddressText(current, current.text, domains));
      }
    },
    pick(next: string) {
      setState({ ...current, domain: next, rejectedDomain: null });
    },
    reset() {
      setState({ text: "", domain, rejectedDomain: null });
    },
  };
}

export type DomainAddress = ReturnType<typeof useDomainAddress>;

/**
 * An address on one of the workspace's mail domains: the person types the local
 * part, and the domain sits inside the field on the right, fixed with one
 * domain and a compact picker with several. A pasted full address fills both.
 */
export function DomainAddressInput({
  id,
  field,
  placeholder,
  required,
  autoFocus,
  describedBy,
  className,
}: {
  id: string;
  field: DomainAddress;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  /** The id of a hint under the field. */
  describedBy?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const typingDomain = splitAddressText(field.text).domain !== null;
  const suffixId = `${id}-domain`;
  const errorId = `${id}-error`;

  useEffect(() => {
    input.current?.setCustomValidity(field.validity);
  }, [field.validity]);

  function change(event: ChangeEvent<HTMLInputElement>) {
    const { nativeEvent } = event;

    const inputType =
      nativeEvent instanceof InputEvent ? nativeEvent.inputType : null;

    // Keystrokes (and phone keyboards' compositions) keep the text; pastes, drops and autofill settle it.
    const typed =
      inputType !== null &&
      (inputType === "insertText" ||
        inputType === "insertCompositionText" ||
        inputType.startsWith("delete"));

    field.change(event.target.value, !typed);
  }

  return (
    <div className="space-y-2">
      <InputGroup className={cn("h-9", className)}>
        <InputGroupInput
          ref={input}
          className="no-autofill-button"
          id={id}
          type="text"
          inputMode="email"
          // A new address: there is nothing to fill in.
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder}
          value={field.text}
          onChange={change}
          onBlur={() => field.settle()}
          required={required}
          autoFocus={autoFocus}
          aria-invalid={field.error ? true : undefined}
          aria-describedby={[suffixId, field.error ? errorId : describedBy]
            .filter(Boolean)
            .join(" ")}
        />
        <InputGroupAddon
          align="inline-end"
          className={cn(
            "max-w-[65%] min-w-0 transition-opacity duration-150",
            field.domains.length > 1 && "py-0 pr-1",
            typingDomain && "opacity-40"
          )}
        >
          {field.domains.length > 1 ? (
            <Select
              value={field.domain}
              onValueChange={(value) => value && field.pick(value)}
            >
              <SelectTrigger
                id={suffixId}
                size="sm"
                aria-label="Domain"
                className="text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground dark:hover:bg-muted h-7 max-w-full min-w-0 gap-1 rounded-md border-0 bg-transparent pr-1.5 pl-2 text-base font-normal shadow-none focus-visible:ring-2 md:text-sm dark:bg-transparent [&_svg:not([class*='size-'])]:size-3.5"
              >
                <SelectValue className="min-w-0 truncate">{`@${field.domain}`}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                {field.domains.map((name) => (
                  <SelectItem key={name} value={name}>{`@${name}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span
              id={suffixId}
              className="min-w-0 truncate text-base font-normal md:text-sm"
              title={`@${field.domain}`}
            >
              @{field.domain}
            </span>
          )}
        </InputGroupAddon>
      </InputGroup>
      {field.error ? (
        <p
          id={errorId}
          className="text-destructive text-xs leading-5 text-pretty"
          role="alert"
        >
          {field.error}
        </p>
      ) : null}
    </div>
  );
}
