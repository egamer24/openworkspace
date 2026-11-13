/** Profile photos people upload under Settings → Profile. */
export const avatarImage = {
  types: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  maxBytes: 2 * 1024 * 1024,
} as const;

/**
 * Square sizes avatars are served at: 128 for the small ones in lists and
 * menus (up to 40px, on screens up to 3x), 256 for the profile page and the
 * `picture` apps get.
 */
export const avatarSizes = [128, 256] as const;

export type AvatarSize = (typeof avatarSizes)[number];

/**
 * Where a person's avatar is served, by its id (`users.avatar_id`). Every
 * upload gets a new id, so the URL is cacheable for good.
 */
export function avatarPath(userId: string, avatarId: string, size: AvatarSize) {
  return `/api/avatars/${encodeURIComponent(userId)}/${avatarId}?size=${size}`;
}

/** A person's avatar at `size`, or undefined without one. */
export function avatarSrc(
  user: { id: string; avatarId: string | null } | null | undefined,
  size: AvatarSize = 128
) {
  return user?.avatarId ? avatarPath(user.id, user.avatarId, size) : undefined;
}
