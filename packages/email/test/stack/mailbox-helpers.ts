import { pollUntil } from "./poll.ts";
import { hooks } from "./workspace.ts";

/**
 * Runs a mailbox's alarm now, then waits until `done` holds. In the stack, alarms also fire
 * on their own (a second after mail is queued), so the scheduled run may
 * already have started or finished; waiting on the outcome covers both.
 */
export function runAlarmUntil<T>(
  mailboxId: string,
  done: () => Promise<T>,
  timeoutMs = 10_000
) {
  return pollUntil(
    async () => {
      await hooks.runAlarm(mailboxId);

      return done();
    },
    {
      timeoutMs,
      failure: `Mailbox ${mailboxId} did not get there in ${timeoutMs} ms`,
    }
  );
}
