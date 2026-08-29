import assert from "node:assert/strict";
import test from "node:test";

import { claimField, deadlineStatus, staleClaimReason } from "./coordination-lib.mjs";

test("claimField reads exact portable fields", () => {
  const body = "Claim-State: active\nClaim-Harness: claude-code\nCheck-In-By: 2026-08-29T22:00:00Z\n";

  assert.equal(claimField(body, "Claim-State"), "active");
  assert.equal(claimField(body, "Claim-Harness"), "claude-code");
  assert.equal(claimField(body, "Claim-Run-ID"), "missing");
});

test("deadlineStatus distinguishes current, overdue, missing, and invalid deadlines", () => {
  const now = Date.parse("2026-08-29T20:00:00Z");

  assert.equal(deadlineStatus("2026-08-29T21:00:00Z", now), "current");
  assert.equal(deadlineStatus("2026-08-29T19:00:00Z", now), "overdue");
  assert.equal(deadlineStatus("unclaimed", now), "unknown");
  assert.equal(deadlineStatus("tomorrowish", now), "invalid");
});

test("only active claims with non-current deadlines are suspected stale", () => {
  const now = Date.parse("2026-08-29T20:00:00Z");

  assert.equal(staleClaimReason("active", "2026-08-29T19:00:00Z", now), "check-in overdue");
  assert.equal(staleClaimReason("active", "missing", now), "check-in unknown");
  assert.equal(staleClaimReason("active", "2026-08-29T21:00:00Z", now), undefined);
  assert.equal(staleClaimReason("blocked", "2026-08-29T19:00:00Z", now), undefined);
});
