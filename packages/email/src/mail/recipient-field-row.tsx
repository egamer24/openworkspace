import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@open-workspace/core/ui";

export function RecipientFieldRow({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <InputGroup className="h-11 rounded-none border-0 bg-transparent shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-0 has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-transparent">
      <InputGroupAddon className="w-14 justify-start pl-0">
        <InputGroupText className="text-xs font-medium">{label}</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        className="px-2 dark:hover:bg-transparent"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="name@example.com"
      />
    </InputGroup>
  );
}
