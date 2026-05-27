// A JS Date bound to a MySQL DATETIME/TIMESTAMP and read back must be the
// same instant regardless of the process timezone. Encode breaks the Date's
// epoch-ms into Y/M/D h:m:s via pure-UTC arithmetic, so decode has to treat
// those components as UTC too — if it interprets them as local time, the
// round-trip silently shifts by the machine's UTC offset.
//
// The fixture runs a mock MySQL server that echoes the bound DATETIME bytes
// straight back as a DATETIME result column, so this runs in CI without
// Docker. We spawn it under several TZ values and assert the identity.

import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import path from "path";

const fixture = path.join(import.meta.dir, "sql-mysql-datetime-roundtrip-fixture.ts");

test.concurrent.each(["UTC", "America/New_York", "Asia/Tokyo"])(
  "DATETIME Date round-trip is the identity under TZ=%s",
  async TZ => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), fixture],
      env: { ...bunEnv, TZ },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    const filteredStderr = stderr
      .split(/\r?\n/)
      .filter(l => l && !l.startsWith("WARNING: ASAN interferes"))
      .join("\n");
    expect(filteredStderr).toBe("");

    const { tz, offsetMin, results } = JSON.parse(stdout.trim()) as {
      tz: string;
      offsetMin: number;
      results: Array<{ in: number; out: number; diffMin: number }>;
    };
    expect(tz).toBe(TZ);
    // Prove the child runtime actually adopted the TZ — otherwise the non-UTC
    // cases silently degenerate into the UTC case and stop exercising the bug.
    if (TZ === "UTC") {
      expect(offsetMin).toBe(0);
    } else {
      expect(offsetMin).not.toBe(0);
    }
    expect(results).toEqual([
      { in: 1718452800000, out: 1718452800000, diffMin: 0 },
      { in: 1705278600000, out: 1705278600000, diffMin: 0 },
      { in: 1735688700000, out: 1735688700000, diffMin: 0 },
    ]);
    expect(exitCode).toBe(0);
  },
);
