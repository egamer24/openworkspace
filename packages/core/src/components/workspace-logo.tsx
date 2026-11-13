import { useState } from "react";

import { useAuth } from "../auth/auth-context";
import { cn } from "../lib/utils";
import { BrandMark } from "./brand-mark";

/** The product's name, shown wherever the workspace has none of its own. */
export const productName = "OpenWorkspace";

/** The workspace's name and logo URL, from the session check; the product's name when unnamed. */
export function useWorkspaceBrand() {
  const { workspaceName, workspaceLogoUrl } = useAuth();

  return { name: workspaceName ?? productName, logoUrl: workspaceLogoUrl };
}

/**
 * The workspace's own logo on a white tile, rounded like the brand mark,
 * with a hairline and a neutral shadow that sit on any image in both themes.
 * Without a logo, or when it fails to load, the OpenWorkspace mark stands in.
 * `className` sets the size and spacing; `flat` drops the shadow, for the
 * small mark in an app header.
 */
export function WorkspaceLogo({
  src,
  className,
  flat = false,
}: {
  src: string | null;
  className?: string;
  flat?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) {
    return (
      <BrandMark
        className={cn(className, !flat && "shadow-[0_8px_24px_-8px_#355cd4aa]")}
      />
    );
  }

  return (
    <img
      src={src}
      alt="Workspace logo"
      decoding="async"
      onError={() => setFailedSrc(src)}
      className={cn(
        "block size-8 shrink-0 rounded-[24%] bg-white object-cover",
        flat
          ? "shadow-[0_0_0_1px_rgb(0_0_0/0.07)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1)]"
          : [
              "shadow-[0_0_0_1px_rgb(0_0_0/0.07),0_8px_22px_-10px_rgb(15_23_42/0.45)]",
              "dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_10px_26px_-8px_rgb(0_0_0/0.85)]",
            ],
        className
      )}
    />
  );
}
