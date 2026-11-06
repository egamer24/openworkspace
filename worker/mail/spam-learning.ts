import type { SpamReason } from "../mailbox/model";

/**
 * Per-mailbox naive Bayes over message tokens. Training comes only from a
 * member moving a conversation into or out of Spam; scoring stays silent
 * until both sides have enough examples.
 */

export const SPAM_LEARNING_MINIMUM = 20;
/** Token rows kept per mailbox; least-used (then oldest) rows are pruned. */
export const MAX_SPAM_TOKENS = 50_000;
/** Pruning removes down to this size so it does not run on every training. */
export const SPAM_TOKENS_PRUNE_TO = 45_000;
export const MAX_MESSAGE_TOKENS = 300;
export const spamLabels = ["spam", "ham"] as const;
export type SpamLabel = (typeof spamLabels)[number];

const BODY_SCAN_CHARACTERS = 64 * 1024;
const INTERESTING_TOKENS = 20;

export type SpamTokenCounts = { spamCount: number; hamCount: number };
export type SpamTrainingTotals = { spam: number; ham: number };

function words(text: string) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= 3 && word.length <= 32);
}

function urlHosts(text: string) {
  return [...text.matchAll(/\bhttps?:\/\/[^\s<>"'()[\]]+/giu)].flatMap((match) => {
    try {
      return [new URL(match[0]).hostname.toLowerCase()];
    } catch {
      return [];
    }
  });
}

/** Unique tokens: sender domain, link hosts, subject words, body words. */
export function messageSpamTokens(input: {
  subject: string;
  bodyText: string | null;
  from: string;
}) {
  const body = (input.bodyText ?? "").slice(0, BODY_SCAN_CHARACTERS);
  const separator = input.from.lastIndexOf("@");
  const domain = separator === -1 ? "" : input.from.slice(separator + 1).toLowerCase();
  const tokens = new Set<string>();
  if (domain) tokens.add(`from:${domain}`);
  for (const host of urlHosts(body)) tokens.add(`url:${host}`);
  for (const word of words(input.subject)) tokens.add(`subject:${word}`);
  for (const word of words(body)) tokens.add(word);
  return [...tokens].slice(0, MAX_MESSAGE_TOKENS);
}

/**
 * Robinson's smoothed per-token probability, combined over the most
 * decisive tokens. Returns null when no token carries a signal.
 */
export function learnedSpamProbability(
  tokens: SpamTokenCounts[],
  totals: SpamTrainingTotals,
) {
  if (totals.spam < SPAM_LEARNING_MINIMUM || totals.ham < SPAM_LEARNING_MINIMUM) {
    return null;
  }
  const probabilities = tokens.flatMap(({ spamCount, hamCount }) => {
    const spamRate = Math.min(1, spamCount / totals.spam);
    const hamRate = Math.min(1, hamCount / totals.ham);
    if (spamRate + hamRate === 0) return [];
    const seen = spamCount + hamCount;
    const probability = (0.5 + seen * (spamRate / (spamRate + hamRate))) / (1 + seen);
    const clamped = Math.min(0.99, Math.max(0.01, probability));
    return Math.abs(clamped - 0.5) >= 0.1 ? [clamped] : [];
  });
  if (!probabilities.length) return null;
  const logOdds = probabilities
    .sort((left, right) => Math.abs(right - 0.5) - Math.abs(left - 0.5))
    .slice(0, INTERESTING_TOKENS)
    .reduce((total, probability) => total + Math.log(probability / (1 - probability)), 0);
  return 1 / (1 + Math.exp(-logOdds));
}

/** Maps the learned probability to -20..+35 points. */
export function learningReasons(probability: number | null): SpamReason[] {
  if (probability === null) return [];
  const points = Math.round(
    probability >= 0.5 ? 70 * (probability - 0.5) : 40 * (probability - 0.5),
  );
  if (!points) return [];
  const shown = probability.toFixed(2);
  return [{
    points,
    reason: points > 0
      ? `Similar to messages you marked as spam (p=${shown})`
      : `Similar to messages you marked as not spam (p=${shown})`,
  }];
}
