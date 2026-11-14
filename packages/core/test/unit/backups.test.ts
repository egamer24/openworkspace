import { describe, expect, it } from "bun:test";

import { backupId, retainedBackupIds } from "../../worker/backups/job.ts";

describe("backup retention", () => {
  const days = Array.from({ length: 120 }, (_, day) =>
    backupId(new Date(Date.UTC(2026, 0, 1 + day, 4, 17)))
  );

  it("names a snapshot by when it started", () => {
    expect(days[0]).toBe("2026-01-01T041700.000Z");
  });

  it("keeps the newest of each of 14 days and of 8 weeks", () => {
    // The newest 14 days (2026-04-17 to 04-30) span 3 ISO weeks; the
    // 5 weeks before keep their Sundays.
    expect(
      [...retainedBackupIds(days, { keepDays: 14, keepWeeks: 8 })].toSorted()
    ).toEqual([
      "2026-03-15T041700.000Z",
      "2026-03-22T041700.000Z",
      "2026-03-29T041700.000Z",
      "2026-04-05T041700.000Z",
      "2026-04-12T041700.000Z",
      ...days.slice(-14),
    ]);
  });

  it("counts days and weeks back from the newest snapshot, gaps included", () => {
    expect([
      ...retainedBackupIds(
        ["2025-01-06T041700.000Z", "2026-03-10T041700.000Z"],
        { keepDays: 14, keepWeeks: 8 }
      ),
    ]).toEqual(["2026-03-10T041700.000Z"]);
  });

  it("counts a day with two snapshots once, keeping its newest", () => {
    expect([
      ...retainedBackupIds(
        [
          "2026-03-09T041700.000Z",
          "2026-03-10T041700.000Z",
          "2026-03-10T120000.000Z",
        ],
        { keepDays: 2, keepWeeks: 0 }
      ),
    ]).toEqual(["2026-03-10T120000.000Z", "2026-03-09T041700.000Z"]);
  });
});
