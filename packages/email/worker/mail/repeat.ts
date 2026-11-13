/**
 * Runs `step` one attempt after another, each starting once the previous one
 * finished, until it returns a value (anything but undefined) or `limit`
 * attempts have run. For loops that are sequential by nature: polling,
 * following redirects, draining a paginated listing.
 */
export async function repeatUntil<T>(
  limit: number,
  step: (attempt: number) => Promise<T | undefined>
): Promise<T | undefined> {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each attempt depends on the one before (that is this helper's contract)
    const value = await step(attempt);

    if (value !== undefined) return value;
  }

  return undefined;
}
