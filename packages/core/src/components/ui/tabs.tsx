import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { useEffect, useRef, useState } from "react";

import { useActiveInView, useEdgeFade } from "../../hooks/use-scroll-edges";
import { cn } from "../../lib/utils";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list text-muted-foreground inline-flex w-fit max-w-full min-w-0 items-center justify-center rounded-xl group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:p-1 data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-surface-sunken ring-border ring-1",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

/**
 * A row of tabs. Horizontally it scrolls when the tabs outgrow it: no
 * scrollbar, a fade only at an edge hiding tabs, and the active tab kept in
 * view. Vertically the scroller steps aside and the tabs stack in the list.
 */
function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  const scroller = useRef<HTMLDivElement>(null);
  const active = useActiveTab(scroller);
  const fade = useEdgeFade(scroller);
  useActiveInView(scroller, active, "[data-active]");

  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      <div
        ref={scroller}
        data-slot="tabs-scroller"
        style={fade}
        className="relative flex size-full min-w-0 [scrollbar-width:none] items-center gap-[inherit] overflow-x-auto overflow-y-hidden overscroll-x-contain p-1 group-data-vertical/tabs:contents [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
    </TabsPrimitive.List>
  );
}

/** The active tab's value as the tablist shows it, so scrolling can follow it. */
function useActiveTab(scroller: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const element = scroller.current;

    if (!element) return;

    const read = () => {
      const tabs = [...element.querySelectorAll('[role="tab"]')];
      setActive(tabs.findIndex((tab) => tab.hasAttribute("data-active")));
    };

    read();
    const observer = new MutationObserver(read);
    observer.observe(element, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-active"],
    });

    return () => observer.disconnect();
  }, [scroller]);

  return active;
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:outline-ring dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2.5 py-0.5 text-sm font-medium whitespace-nowrap transition-all duration-150 ease-out group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-[variant=default]/tabs-list:data-active:shadow-xs group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:hover:bg-accent/60 group-data-[variant=line]/tabs-list:data-active:text-foreground group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-surface data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:bg-primary after:absolute after:rounded-full after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-[3px] group-data-vertical/tabs:after:inset-y-1 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-[3px] group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
