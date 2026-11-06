import { Fragment, useState } from "react";
import {
  ArrowLeft,
  FileKey2,
  Globe2,
  KeyRound,
  Menu,
  Plane,
  Settings2,
  type LucideIcon,
  Users,
  UsersRound,
  Webhook,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type AdminSection =
  | "people"
  | "mailboxes"
  | "auto-replies"
  | "domains"
  | "sso-applications"
  | "saml-applications"
  | "groups"
  | "webhooks";

const adminSections: Array<{
  id: AdminSection;
  label: string;
  Icon: LucideIcon;
  separatorBefore?: boolean;
}> = [
  { id: "people", label: "People", Icon: Users },
  { id: "mailboxes", label: "Mailboxes", Icon: Settings2 },
  { id: "auto-replies", label: "Auto-replies", Icon: Plane },
  { id: "domains", label: "Domains", Icon: Globe2 },
  { id: "webhooks", label: "Webhooks", Icon: Webhook },
  { id: "sso-applications", label: "OIDC applications", Icon: KeyRound, separatorBefore: true },
  { id: "saml-applications", label: "SAML applications", Icon: FileKey2 },
  { id: "groups", label: "Identity groups", Icon: UsersRound },
];

export function AdminNavigation({
  value,
  onChange,
  onNavigate,
}: {
  value: AdminSection;
  onChange: (value: AdminSection) => void;
  onNavigate?: () => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onChange(next as AdminSection)}
      orientation="vertical"
      className="p-3"
    >
      <TabsList variant="line" className="w-full items-stretch gap-0.5">
        {adminSections.map(({ id, label, Icon, separatorBefore }) => (
          <Fragment key={id}>
            {separatorBefore ? <Separator className="my-2.5 bg-border/70" /> : null}
            <TabsTrigger
              value={id}
              onClick={() => {
                if (id === value) onChange(id);
                onNavigate?.();
              }}
              className="h-9 justify-start gap-2.5 rounded-md px-3 text-[0.8125rem] after:hidden group-data-[variant=line]/tabs-list:hover:bg-sidebar-accent group-data-[variant=line]/tabs-list:data-active:bg-sidebar-accent group-data-[variant=line]/tabs-list:data-active:font-semibold data-active:[&_svg]:text-primary"
            >
              <Icon /> {label}
            </TabsTrigger>
          </Fragment>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function MobileAdminMenu({
  value,
  onChange,
  onBack,
}: {
  value: AdminSection;
  onChange: (value: AdminSection) => void;
  onBack: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button className="md:hidden" variant="ghost" size="icon-sm" />}
      >
        <Menu />
        <span className="sr-only">Open administration navigation</span>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="min-h-0 w-72 gap-0 p-0"
        showCloseButton
      >
        <SheetHeader className="shrink-0 border-b border-border/70 pr-12">
          <SheetTitle className="font-semibold tracking-[-0.01em]">OpenWorkspace</SheetTitle>
          <SheetDescription>Administration</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <AdminNavigation
            value={value}
            onChange={(next) => {
              setOpen(false);
              onChange(next);
            }}
            onNavigate={() => setOpen(false)}
          />
        </ScrollArea>
        <SheetFooter className="shrink-0 border-t border-border/70">
          <Button
            className="w-full justify-start"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              onBack();
            }}
          >
            <ArrowLeft /> Back to mail
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
