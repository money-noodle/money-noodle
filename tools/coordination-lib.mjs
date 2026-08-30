export function claimField(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, "m"))?.[1]?.trim() ?? "missing";
}

export function deadlineStatus(value, nowMs = Date.now()) {
  if (["missing", "unclaimed", "none", ""].includes(value.toLowerCase())) return "unknown";
  const deadline = Date.parse(value);
  if (Number.isNaN(deadline)) return "invalid";
  return deadline < nowMs ? "overdue" : "current";
}

export function staleClaimReason(state, checkIn, nowMs = Date.now()) {
  if (state !== "active") return undefined;
  const status = deadlineStatus(checkIn, nowMs);
  return status === "current" ? undefined : `check-in ${status}`;
}
