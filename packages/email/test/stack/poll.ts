import { poll } from "@open-workspace/core/testing";

/**
 * Calls `attempt` until it returns a truthy value, `intervalMs` apart, and
 * returns that value; throws `failure` once `timeoutMs` has passed. For
 * state the stack reaches in the background (alarms, queued work).
 */
export async function pollUntil<T>(
  attempt: () => Promise<T>,
  {
    timeoutMs = 10_000,
    intervalMs = 50,
    failure,
  }: { timeoutMs?: number; intervalMs?: number; failure: string }
): Promise<T> {
  const value = await poll(attempt, Boolean, {
    timeout: timeoutMs,
    interval: intervalMs,
  });

  if (!value) throw new Error(failure);

  return value;
}
