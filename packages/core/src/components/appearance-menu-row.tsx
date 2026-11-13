import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Monitor, Moon, Sun, SunMoon } from "lucide-react";
import { useId } from "react";

import { themeSchema, useTheme } from "../hooks/use-theme";
import type { Theme } from "../hooks/use-theme";
import { cn } from "../lib/utils";

const themes: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/**
 * One row of a dropdown menu: "Theme" and a segmented control of icons for
 * light, dark and system. The segments are the menu's radio items, so the
 * arrow keys reach them, and choosing one keeps the menu open.
 */
export function AppearanceMenuRow() {
  const { theme, setTheme } = useTheme();
  const labelId = useId();

  return (
    <div className="flex items-center justify-between gap-3 py-1 pr-1 pl-2">
      <span id={labelId} className="flex items-center gap-2 text-sm">
        <SunMoon aria-hidden="true" className="size-4 shrink-0" />
        Theme
      </span>
      <MenuPrimitive.RadioGroup
        value={theme}
        onValueChange={(value) => {
          const choice = themeSchema.safeParse(value);

          if (choice.success) setTheme(choice.data);
        }}
        aria-labelledby={labelId}
        className="border-border bg-surface-sunken flex h-8 items-center gap-0.5 rounded-md border p-0.5"
      >
        {themes.map(({ value, label, Icon }) => (
          <MenuPrimitive.RadioItem
            key={value}
            value={value}
            closeOnClick={false}
            aria-label={label}
            title={label}
            className={cn(
              "text-muted-foreground grid h-full w-8 cursor-default place-items-center rounded-[4px] transition-colors outline-none select-none",
              "data-highlighted:text-foreground data-highlighted:not-data-checked:bg-foreground/[0.06]",
              "data-checked:bg-surface data-checked:text-foreground data-checked:ring-border data-checked:shadow-xs data-checked:ring-1",
              "[&_svg]:size-4"
            )}
          >
            <Icon aria-hidden="true" />
          </MenuPrimitive.RadioItem>
        ))}
      </MenuPrimitive.RadioGroup>
    </div>
  );
}
