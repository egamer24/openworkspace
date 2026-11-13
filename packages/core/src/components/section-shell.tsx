import { ArrowLeft, LoaderCircle, Menu } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { cn } from "../lib/utils";
import { homeLabel } from "../modules";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";
import { useWorkspaceBrand, WorkspaceLogo } from "./workspace-logo";

/**
 * The frame settings and administration share: a sidebar with grouped
 * sections (a sheet on phones), the section's title, and its page.
 * `renderNavigation` renders the section list; it gets `onNavigate` inside the
 * phone sheet, to close it.
 */
export function SectionShell({
  area,
  renderNavigation,
  title,
  description,
  actions,
  className,
  children,
}: {
  area: string;
  renderNavigation: (onNavigate?: () => void) => ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** The page's width, e.g. max-w-3xl. */
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const brand = useWorkspaceBrand();
  useEffect(() => {
    document.title = brand.name;
  }, [brand.name]);

  const back = (
    <Button
      className="w-full justify-start"
      variant="ghost"
      onClick={() => navigate("/")}
    >
      <ArrowLeft /> Back to {homeLabel()}
    </Button>
  );

  return (
    <main className="bg-background flex h-dvh min-h-0">
      <aside className="border-sidebar-border bg-sidebar hidden w-64 shrink-0 flex-col border-r md:flex">
        <div className="border-sidebar-border flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
          <WorkspaceLogo src={brand.logoUrl} flat />
          <div className="min-w-0">
            <p className="truncate text-[0.875rem] leading-tight font-semibold tracking-[-0.01em]">
              {brand.name}
            </p>
            <p className="text-muted-foreground text-[11px] leading-tight">
              {area}
            </p>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">{renderNavigation()}</ScrollArea>
        <div className="border-sidebar-border shrink-0 border-t p-3">
          {back}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-border bg-surface flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6 lg:px-8">
          <SectionMenu area={area} renderNavigation={renderNavigation} />
          <div className="min-w-0">
            <h1 className="truncate text-base leading-tight font-semibold tracking-[-0.015em] sm:text-lg">
              {title}
            </h1>
            {description ? (
              <p className="text-muted-foreground hidden truncate text-xs sm:block">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {actions}
            </div>
          ) : null}
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className={cn("mx-auto w-full p-4 sm:p-6 lg:p-8", className)}>
            <Suspense
              fallback={
                <div
                  className="grid min-h-48 place-items-center"
                  role="status"
                  aria-label="Loading"
                >
                  <LoaderCircle className="text-muted-foreground animate-spin" />
                </div>
              }
            >
              {children}
            </Suspense>
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}

function SectionMenu({
  area,
  renderNavigation,
}: {
  area: string;
  renderNavigation: (onNavigate?: () => void) => ReactNode;
}) {
  const navigate = useNavigate();
  const brand = useWorkspaceBrand();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            className="-ml-1.5 md:hidden"
            variant="ghost"
            size="icon-sm"
          />
        }
      >
        <Menu />
        <span className="sr-only">Open {area.toLowerCase()} navigation</span>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="min-h-0 w-72 gap-0 p-0"
        showCloseButton
      >
        <SheetHeader className="border-border/70 shrink-0 border-b pr-12">
          <SheetTitle className="truncate font-semibold tracking-[-0.01em]">
            {brand.name}
          </SheetTitle>
          <SheetDescription>{area}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          {renderNavigation(close)}
        </ScrollArea>
        <SheetFooter className="border-border/70 shrink-0 border-t">
          <Button
            className="w-full justify-start"
            variant="ghost"
            onClick={() => {
              close();
              navigate("/");
            }}
          >
            <ArrowLeft /> Back to {homeLabel()}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** A group's name in a section list ("Account", "Workspace", or a module's app). */
export function SectionGroupLabel({
  first,
  children,
}: {
  first: boolean;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "text-muted-foreground px-3 pb-1.5 text-[0.6875rem] font-semibold tracking-[0.08em] uppercase",
        first ? "pt-1" : "pt-5"
      )}
    >
      {children}
    </p>
  );
}

/** One section's row in a section list; `active` marks the open one. */
export function sectionItemClass(active: boolean) {
  return cn(
    "focus-visible:ring-ring/50 flex h-9 items-center justify-start gap-2.5 rounded-md px-3 text-[0.8125rem] font-medium transition-colors outline-none focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0",
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground [&_svg]:text-primary font-semibold"
      : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground"
  );
}
