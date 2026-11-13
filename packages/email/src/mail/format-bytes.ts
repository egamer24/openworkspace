export function formatBytes(value: number) {
  if (value < 1000) return `${value} B`;

  if (value < 1_000_000) return `${Math.round(value / 1000)} KB`;

  return `${(value / 1_000_000).toFixed(1)} MB`;
}
