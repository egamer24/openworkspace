import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageUp, LoaderCircle, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { workspaceLogo, workspaceName } from "../../shared/workspace";
import { useAuth } from "../auth/auth-context";
import { BrandMark } from "../components/brand-mark";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { productName, WorkspaceLogo } from "../components/workspace-logo";
import { api, responseJson } from "../lib/api";
import { cn } from "../lib/utils";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
} from "./admin-panel";

/** Wider or taller than this and the rounded square crops too much of it. */
const MAX_ASPECT_RATIO = 1.5;

async function imageSize(file: File) {
  const url = URL.createObjectURL(file);

  try {
    return await new Promise<{ width: number; height: number } | null>(
      (resolve) => {
        const image = new Image();
        image.addEventListener("load", () =>
          resolve({ width: image.naturalWidth, height: image.naturalHeight })
        );
        image.addEventListener("error", () => resolve(null));
        image.src = url;
      }
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Why the file can't be the logo, or null when it can. */
async function logoProblem(file: File) {
  if (!workspaceLogo.types.some((type) => type === file.type)) {
    return "The logo must be a PNG, JPEG, or WebP image.";
  }

  if (file.size > workspaceLogo.maxBytes) {
    return "The logo must be at most 1 MB.";
  }

  const size = await imageSize(file);

  if (!size) return "This image could not be read.";

  const ratio =
    Math.max(size.width, size.height) / Math.min(size.width, size.height);

  if (ratio > MAX_ASPECT_RATIO) {
    return "Use a square, or nearly square, image: the logo is shown in a rounded square.";
  }

  return null;
}

/** Administration > Branding: the workspace's name, then its logo. */
export function BrandingSettings() {
  return (
    <div className="max-w-3xl space-y-6">
      <WorkspaceNameSettings />
      <WorkspaceLogoSettings />
    </div>
  );
}

/** The name the app's header and the browser tab show in place of the product's. */
function WorkspaceNameSettings() {
  const { workspaceName: saved } = useAuth();
  const client = useQueryClient();
  // Null until edited, so a name saved elsewhere shows through.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved ?? "";

  const save = useMutation({
    mutationFn: async (name: string) =>
      responseJson(await api.api.admin.branding.name.$put({ json: { name } })),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["auth-state"] });
      setDraft(null);
      toast.success(result.name ? "Name saved" : "Name removed");
    },
    onError: (error) => toast.error(error.message),
  });

  const changed = value.trim() !== (saved ?? "");

  function submit(event: FormEvent) {
    event.preventDefault();

    if (changed) save.mutate(value.trim());
  }

  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelBody className="space-y-2">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input
          id="workspace-name"
          value={value}
          maxLength={workspaceName.maxLength}
          placeholder={productName}
          autoComplete="organization"
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="text-muted-foreground text-xs leading-5 text-pretty">
          Shown next to the logo in the app's header and in the browser tab.
          Leave it empty to show {productName}.
        </p>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button type="submit" disabled={!changed || save.isPending}>
          {save.isPending ? <LoaderCircle className="animate-spin" /> : null}
          Save name
        </Button>
      </AdminPanelFooter>
    </form>
  );
}

/** The logo the app's header and the screens around signing in show. */
function WorkspaceLogoSettings() {
  const { workspaceLogoUrl } = useAuth();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  function showPreview(url: string | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(url);
  }

  const upload = useMutation({
    mutationFn: async (file: File) =>
      responseJson(await api.api.admin.branding.logo.$post({ form: { file } })),
    onSuccess: async () => {
      // The new URL comes with the session check, which the sign-in screens read.
      await client.invalidateQueries({ queryKey: ["auth-state"] });
      showPreview(null);
      toast.success("Logo updated");
    },
    onError: (error) => {
      showPreview(null);
      toast.error(error.message);
    },
  });

  const remove = useMutation({
    mutationFn: async () =>
      responseJson(await api.api.admin.branding.logo.$delete()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["auth-state"] });
      toast.success("Logo removed");
    },
    onError: (error) => toast.error(error.message),
  });

  const pending = upload.isPending || remove.isPending;
  const logo = previewUrl ?? workspaceLogoUrl;

  async function choose(file: File | undefined) {
    if (!file) return;
    const problem = await logoProblem(file);

    if (problem) {
      toast.error(problem);

      return;
    }

    showPreview(URL.createObjectURL(file));
    upload.mutate(file);
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelBody className="grid gap-6 sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="flex items-end gap-4">
          <WorkspaceLogo src={logo} className="size-24" />
          <WorkspaceLogo src={logo} className="size-12" />
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-semibold">
            {logo
              ? "Your logo"
              : "No logo yet: the OpenWorkspace mark is shown"}
          </p>
          <p className="text-muted-foreground text-xs leading-5 text-pretty">
            PNG, JPEG, or WebP up to 1 MB. A square image of at least 192 × 192
            pixels works best; it is shown in a rounded square, and transparent
            areas show on white.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={workspaceLogo.types.join(",")}
          aria-label="Logo image"
          className="sr-only"
          onChange={(event) => {
            void choose(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </AdminPanelBody>
      <div className="border-border/70 bg-surface-sunken/60 grid gap-3 border-t p-5 sm:grid-cols-2">
        <SignInPreview logo={logo} theme="light" />
        <SignInPreview logo={logo} theme="dark" />
      </div>
      <AdminPanelFooter className="justify-between">
        <Button
          type="button"
          variant="outline"
          disabled={pending || !workspaceLogoUrl}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Trash2 />
          )}
          Remove
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <ImageUp />
          )}
          {workspaceLogoUrl ? "Replace logo" : "Upload logo"}
        </Button>
      </AdminPanelFooter>
    </div>
  );
}

/** The page tokens of each theme (theme.css), whichever theme the admin uses. */
const previewTheme = {
  light:
    "[--background:oklch(0.953_0.006_262)] [--foreground:oklch(0.205_0.018_266)] [--border:oklch(0.915_0.006_262)]",
  dark: "dark [--background:oklch(0.135_0_0)] [--foreground:oklch(0.94_0_0)] [--border:oklch(1_0_0/0.08)]",
};

/** The sign-in screen in miniature, in one theme. */
function SignInPreview({
  logo,
  theme,
}: {
  logo: string | null;
  theme: "light" | "dark";
}) {
  return (
    <figure className="space-y-2">
      <div
        aria-hidden="true"
        // Not merged with cn, which would take bg-dot-grid for a second background color.
        className={`${previewTheme[theme]} bg-background bg-dot-grid text-foreground ring-border relative grid h-44 place-items-center overflow-hidden rounded-lg ring-1`}
      >
        <div className="absolute top-2.5 left-3 flex items-center gap-1.5">
          <BrandMark className="size-4" />
          <span className="text-[0.625rem] font-semibold tracking-[-0.01em]">
            OpenWorkspace
          </span>
        </div>
        <div className="flex w-36 flex-col items-center">
          <WorkspaceLogo src={logo} className="mb-2.5 size-9" />
          <p className="text-[0.75rem] leading-tight font-semibold tracking-[-0.02em]">
            Sign in to your workspace
          </p>
          <span
            className={cn(
              "mt-3 h-5 w-full rounded-md",
              theme === "dark" ? "bg-[#4f74e6]" : "bg-[#355cd4]"
            )}
          />
        </div>
      </div>
      <figcaption className="text-muted-foreground text-xs">
        Sign-in screen, {theme} theme
      </figcaption>
    </figure>
  );
}
