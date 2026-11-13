import { describe, expect, it } from "bun:test";

import { avatarImage } from "../../shared/avatar.ts";
import { workspaceLogo } from "../../shared/workspace.ts";
import { sniffImageType } from "../../worker/lib/stored-image.ts";
import {
  logoObjectKey,
  workspaceBranding,
} from "../../worker/workspace-branding.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => new TextEncoder().encode(text);

describe("uploaded image type", () => {
  it("reads PNG, JPEG and WebP from the bytes", () => {
    expect(
      sniffImageType(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0),
        workspaceLogo.types
      )
    ).toBe("image/png");
    expect(
      sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0), workspaceLogo.types)
    ).toBe("image/jpeg");
    expect(
      sniffImageType(
        ascii("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "),
        workspaceLogo.types
      )
    ).toBe("image/webp");
  });

  it("takes GIF only where it is allowed (avatars, not the logo)", () => {
    expect(sniffImageType(ascii("GIF89a"), avatarImage.types)).toBe(
      "image/gif"
    );
    expect(sniffImageType(ascii("GIF87a"), avatarImage.types)).toBe(
      "image/gif"
    );
    expect(sniffImageType(ascii("GIF89a"), workspaceLogo.types)).toBeNull();
  });

  it("refuses everything else", () => {
    expect(
      sniffImageType(
        ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        avatarImage.types
      )
    ).toBeNull();
    expect(
      sniffImageType(
        ascii("RIFF\u0000\u0000\u0000\u0000WAVE"),
        avatarImage.types
      )
    ).toBeNull();
    expect(sniffImageType(new Uint8Array(), avatarImage.types)).toBeNull();
  });
});

describe("workspace branding", () => {
  it("builds the logo's URL from its id, or is null without a logo", () => {
    const logoId = "0123456789abcdef0123456789abcdef";
    expect(
      workspaceBranding([{ key: "workspace_logo_id", value: logoId }])
    ).toEqual({
      logoId,
      logoUrl: `/api/workspace-logo/${logoId}`,
      name: null,
    });
    expect(workspaceBranding([]).logoUrl).toBeNull();
  });

  it("keys each logo upload in the media bucket by its id", () => {
    expect(logoObjectKey("0123456789abcdef0123456789abcdef")).toBe(
      "workspace/logo/0123456789abcdef0123456789abcdef"
    );
  });

  it("reads the workspace's name, null when unset or blank", () => {
    expect(
      workspaceBranding([{ key: "workspace_name", value: "Acme" }]).name
    ).toBe("Acme");
    expect(
      workspaceBranding([{ key: "workspace_name", value: "  " }]).name
    ).toBeNull();
    expect(workspaceBranding([]).name).toBeNull();
  });
});
