import { Monitor, Moon, Sun } from "lucide-react";

import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "../admin/admin-panel";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import { useTheme } from "../hooks/use-theme";
import type { Theme } from "../hooks/use-theme";

const themeOptions: {
  value: Theme;
  label: string;
  Icon: typeof Sun;
  description: string;
}[] = [
  {
    value: "system",
    label: "System",
    Icon: Monitor,
    description: "Match your device preference.",
  },
  {
    value: "light",
    label: "Light",
    Icon: Sun,
    description: "Bright surfaces and high contrast.",
  },
  {
    value: "dark",
    label: "Dark",
    Icon: Moon,
    description: "Dim surfaces for low light.",
  },
];

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Monitor}
        title="Theme"
        description="Choose how OpenWorkspace looks on this device."
      />
      <AdminPanelBody>
        <RadioGroup
          aria-label="Theme"
          className="gap-3 sm:grid-cols-3"
          value={theme}
          onValueChange={(value: Theme) => setTheme(value)}
        >
          {themeOptions.map(({ value, label, Icon, description }) => (
            <RadioCard
              key={value}
              value={value}
              indicator={false}
              className="text-muted-foreground not-data-checked:bg-surface-sunken not-data-checked:hover:text-foreground data-checked:text-foreground flex-col gap-3 px-4 py-4"
            >
              <Icon className="size-5" />
              <span>
                <span className="text-foreground block text-sm font-semibold">
                  {label}
                </span>
                <span className="text-muted-foreground mt-1 block text-xs">
                  {description}
                </span>
              </span>
            </RadioCard>
          ))}
        </RadioGroup>
      </AdminPanelBody>
    </div>
  );
}
