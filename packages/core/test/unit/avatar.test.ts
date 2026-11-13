import { describe, expect, it } from "bun:test";

import { avatarSrc } from "../../shared/avatar.ts";
import { avatarObjectKey, avatarUrl } from "../../worker/auth/avatar.ts";

const avatarId = "0123456789abcdef0123456789abcdef";

describe("avatar URLs", () => {
  it("are built from the person and the avatar's id, on the workspace's origin", () => {
    expect(avatarSrc({ id: "usr_1", avatarId })).toBe(
      `/api/avatars/usr_1/${avatarId}?size=128`
    );
    expect(avatarSrc({ id: "usr_1", avatarId }, 256)).toBe(
      `/api/avatars/usr_1/${avatarId}?size=256`
    );
    // The OIDC `picture` claim: absolute, the large size.
    expect(
      avatarUrl("https://mail.example.com", { id: "usr_1", avatarId })
    ).toBe(`https://mail.example.com/api/avatars/usr_1/${avatarId}?size=256`);
  });

  it("are absent without a photo", () => {
    expect(avatarSrc({ id: "usr_1", avatarId: null })).toBeUndefined();
    expect(avatarSrc(null)).toBeUndefined();
    expect(
      avatarUrl("https://mail.example.com", { id: "usr_1", avatarId: null })
    ).toBeNull();
  });
});

describe("avatar storage", () => {
  it("keys each upload in the media bucket by its owner and id", () => {
    expect(avatarObjectKey("usr_1", avatarId)).toBe(
      `avatars/usr_1/${avatarId}`
    );
  });
});
