import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  useDebouncedValue,
  cn,
} from "@open-workspace/core/ui";
import { Check, LoaderCircle } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
} from "react";

import { normalizeExternalEmailAddress } from "../../shared/mail";
import {
  normalizeComposerRecipient,
  parseComposerRecipients,
  RECIPIENT_SEPARATOR,
} from "./composer-recipients";
import type {
  ComposerRecipient,
  RecipientFieldValue,
} from "./composer-recipients";
import { Monogram } from "./mail-primitives";
import { useRecipientSuggestions } from "./use-mail-data";

/**
 * A recipients field: chosen addresses as chips, typed text committed on
 * Enter, comma, semicolon, Tab or leaving the field, pasted lists split into
 * chips, and contact suggestions in a list that Escape closes.
 */
export function RecipientCombobox({
  mailboxId,
  label,
  value,
  excludedAddresses,
  autoFocus = false,
  disabled = false,
  actions,
  onChange,
}: {
  mailboxId: string;
  label: string;
  value: RecipientFieldValue;
  excludedAddresses: ReadonlySet<string>;
  autoFocus?: boolean;
  disabled?: boolean;
  actions?: ReactNode;
  onChange: (value: RecipientFieldValue) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  // Escape, or a click outside, hides the list until the text changes.
  const [dismissed, setDismissed] = useState(false);
  // The option the arrow keys or pointer are on. Without one, Enter takes the
  // first suggestion, which looks highlighted for that reason.
  const [highlighted, setHighlighted] = useState<ComposerRecipient>();
  const chipsRef = useRef<HTMLDivElement>(null);
  const query = useDebouncedValue(value.input.trim(), 120);

  const suggestionsQuery = useRecipientSuggestions(
    mailboxId,
    query,
    focused && !disabled && Boolean(value.input.trim())
  );

  const selected = useMemo(
    () =>
      new Set(
        value.recipients.map((recipient) =>
          normalizeExternalEmailAddress(recipient.address)
        )
      ),
    [value.recipients]
  );

  const suggestions = (suggestionsQuery.data?.suggestions ?? []).flatMap(
    (suggestion) => {
      const normalized = normalizeComposerRecipient(suggestion);

      if (
        !normalized ||
        selected.has(normalized.address) ||
        excludedAddresses.has(normalized.address)
      ) {
        return [];
      }

      return [normalized];
    }
  );

  const open =
    !disabled &&
    focused &&
    !dismissed &&
    Boolean(value.input.trim()) &&
    suggestions.length > 0;

  function addRecipients(recipients: ComposerRecipient[]) {
    if (!recipients.length) return;
    const seen = new Set([...selected, ...excludedAddresses]);

    const next = recipients.flatMap((recipient) => {
      const normalized = normalizeComposerRecipient(recipient);

      if (!normalized || seen.has(normalized.address)) return [];
      seen.add(normalized.address);

      return [normalized];
    });

    if (!next.length) {
      onChange({ ...value, input: "" });

      return;
    }

    setInvalid(false);
    onChange({
      recipients: [...value.recipients, ...next],
      input: "",
    });
  }

  function commitInput() {
    const parsed = parseComposerRecipients(value.input);
    const hasInvalid = parsed.invalidParts.length > 0;
    setInvalid(hasInvalid);

    if (hasInvalid || !parsed.recipients.length) return false;
    addRecipients(parsed.recipients);

    return true;
  }

  // Runs before the combobox's own keys: an Enter on a highlighted suggestion
  // and Backspace on an empty field (removing the last chip) are left to it.
  function handleKeyDown(
    event: KeyboardEvent<HTMLInputElement> & {
      preventBaseUIHandler: () => void;
    }
  ) {
    if (event.key === "Escape") {
      // With the list closed the combobox would clear every chip; leave the
      // key to the page instead (the phone composer closes on it).
      if (!open) event.preventBaseUIHandler();

      return;
    }

    if (event.key === "Enter" && open) {
      if (highlighted) return;
      event.preventDefault();
      event.preventBaseUIHandler();
      const [first] = suggestions;

      if (first) addRecipients([first]);

      return;
    }

    if (
      event.key === "Enter" ||
      event.key === "Tab" ||
      event.key === "," ||
      event.key === ";"
    ) {
      if (!value.input.trim()) return;

      if (event.key === "Tab") {
        // An address that does not parse keeps focus here, marked invalid.
        if (!commitInput()) event.preventDefault();

        return;
      }

      event.preventDefault();
      event.preventBaseUIHandler();
      commitInput();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");

    if (!RECIPIENT_SEPARATOR.test(text)) return;
    const parsed = parseComposerRecipients(text);

    if (parsed.invalidParts.length || !parsed.recipients.length) {
      setInvalid(parsed.invalidParts.length > 0);

      return;
    }

    event.preventDefault();
    addRecipients(parsed.recipients);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget;

    if (event.currentTarget.contains(next)) return;

    // The suggestion list is portalled; moving into it is not leaving the field.
    if (
      next instanceof Element &&
      next.closest("[data-slot=combobox-content]")
    ) {
      return;
    }

    setFocused(false);

    if (value.input.trim()) commitInput();
  }

  return (
    <Combobox<ComposerRecipient, true>
      multiple
      items={suggestions}
      filter={null}
      value={value.recipients}
      inputValue={value.input}
      open={open}
      disabled={disabled}
      autoHighlight
      openOnInputClick={false}
      isItemEqualToValue={(item, other) => item.address === other.address}
      itemToStringLabel={(recipient) => recipient.name || recipient.address}
      onItemHighlighted={(recipient) => setHighlighted(recipient)}
      onOpenChange={(next) => setDismissed(!next)}
      onInputValueChange={(next, details) => {
        // The combobox clears its text when the list closes; typed addresses stay until committed.
        if (details.reason !== "input-change") return;
        setInvalid(false);
        setDismissed(false);
        onChange({ ...value, input: next });
      }}
      onValueChange={(next, details) => {
        if (details.reason === "escape-key") return;

        if (next.length > value.recipients.length) {
          addRecipients(
            next.filter((recipient) => !selected.has(recipient.address))
          );

          return;
        }

        onChange({ ...value, recipients: next });
      }}
    >
      <div
        className="relative flex min-h-11 items-start gap-2 py-2"
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
      >
        <span className="text-muted-foreground flex h-7 w-14 shrink-0 items-center text-xs font-medium">
          {label}
        </span>
        <ComboboxChips ref={chipsRef} className="flex-1">
          {value.recipients.map((recipient) => (
            <ComboboxChip
              key={recipient.address}
              title={recipient.address}
              removeLabel={`Remove ${recipient.address}`}
              disabled={disabled}
            >
              <span className="max-w-44 truncate">
                {recipient.name || recipient.address}
              </span>
            </ComboboxChip>
          ))}
          <ComboboxChipsInput
            className={cn(
              invalid && "text-destructive placeholder:text-destructive/70"
            )}
            aria-label={`${label} recipients`}
            aria-invalid={invalid}
            autoFocus={autoFocus}
            placeholder={value.recipients.length ? "" : "name@example.com"}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        </ComboboxChips>
        {focused && suggestionsQuery.isFetching ? (
          <LoaderCircle className="text-muted-foreground mt-1.5 size-3.5 shrink-0 animate-spin" />
        ) : null}
        {actions}
      </div>

      <ComboboxContent
        anchor={chipsRef}
        sideOffset={2}
        aria-label={`${label} suggestions`}
        className="rounded-xl p-1.5 shadow-xl"
      >
        <ComboboxList>
          {(suggestion: ComposerRecipient, index: number) => (
            <ComboboxItem
              key={suggestion.address}
              value={suggestion}
              data-default={(index === 0 && !highlighted) || undefined}
              className="group/suggestion data-default:bg-accent data-default:text-accent-foreground gap-2 rounded-lg px-2.5 py-2"
            >
              <Monogram
                name={suggestion.name || suggestion.address}
                className="size-7 rounded-full text-[10px]"
              />
              <span className="min-w-0 flex-1">
                {suggestion.name ? (
                  <span className="block truncate font-medium">
                    {suggestion.name}
                  </span>
                ) : null}
                <span className="text-muted-foreground block truncate text-xs">
                  {suggestion.address}
                </span>
              </span>
              <Check className="size-3.5 opacity-0 group-data-default/suggestion:opacity-100 group-data-highlighted/suggestion:opacity-100" />
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
