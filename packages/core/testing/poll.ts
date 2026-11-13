/**
 * Waiting for work that finishes on its own time (a queue retry, a lease
 * running out, a background sync): calls `attempt` until `done` accepts what
 * it returned or `timeout` ms have passed, and returns the last result, so
 * the test's own assertion reports what it saw. Usable in the test process
 * and inside the test Worker alike.
 */
export function poll<T>(
  attempt: () => T | Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions = {}
): Promise<T> {
  const { timeout = 30_000, interval = 100 } = options;
  const deadline = Date.now() + timeout;

  const next = async (): Promise<T> => {
    const value = await attempt();

    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => {
      setTimeout(resolve, interval);
    });

    return next();
  };

  return next();
}

export type PollOptions = {
  /** How long to keep trying, in ms (30 s by default). */
  timeout?: number;
  /** The pause between attempts, in ms (100 by default). */
  interval?: number;
};
