import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

export type ConfirmOptions = {
  /** A question naming what happens, such as "Delete Design?". */
  title: string;
  description: ReactNode;
  /** The confirming button's label, naming the action: "Delete team", not "OK". */
  action: string;
  /** Styles the action as destructive, for steps that lose data or access. */
  destructive?: boolean;
};

/**
 * An in-app `window.confirm`: `confirm(options)` opens an alert dialog and
 * resolves to whether the action was chosen. Render `dialog` once, anywhere
 * in the component.
 */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed);
    resolver.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    resolver.current?.(false);
    setOptions(next);
    setOpen(true);

    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const dialog = (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setOptions(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {options?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant={options?.destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {options?.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
