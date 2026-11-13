import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Two letters for an avatar: first and last word ("Maya Chen" → "MC"), or a single word's first two. */
export function initials(value: string) {
  const words = value
    .replaceAll(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  if (!words.length) return "?";
  const first = words[0]?.[0] ?? "";

  const second =
    words.length > 1 ? (words.at(-1)?.[0] ?? "") : (words[0]?.[1] ?? "");

  return (first + second).toUpperCase();
}
