/** A handle suggested from a display name: "Team lead" becomes "team-lead". */
export function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}
