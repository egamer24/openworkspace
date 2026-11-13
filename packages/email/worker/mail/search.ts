const SEARCH_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const MAX_SEARCH_TOKENS = 24;

/**
 * User input never reaches FTS5 query syntax directly. Each Unicode word is
 * quoted and treated as a prefix, which supports partial names and addresses.
 */
export function buildEmailSearchQuery(value: string) {
  const tokens = value.normalize("NFKC").match(SEARCH_TOKEN_PATTERN) ?? [];
  const unique = [...new Set(tokens)].slice(0, MAX_SEARCH_TOKENS);

  return unique.length
    ? unique.map((token) => `"${token}"*`).join(" AND ")
    : null;
}
