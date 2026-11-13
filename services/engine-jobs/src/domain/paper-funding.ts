// Historical allocation arithmetic under EXPLICIT current caps, never zero-as-unbounded.
// Pure feasibility result only; no persisted-intent binding or spending authority.
export function paperMarketFunding(input: {
  providerLimitCents: number;
  allocationPercent: number;
  modeEquityCents: number;
  availableCents: number;
  pairReservedCents: number;
}) {
  const {
    providerLimitCents,
    allocationPercent,
    modeEquityCents,
    availableCents,
    pairReservedCents,
  } = input;
  if (
    ![providerLimitCents, modeEquityCents, availableCents, pairReservedCents].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    providerLimitCents <= 0 ||
    !Number.isFinite(allocationPercent) ||
    allocationPercent < 0 ||
    allocationPercent > 100
  ) {
    throw new Error('Missing or invalid explicit paper funding cap.');
  }
  const equityCents = Math.min(modeEquityCents, providerLimitCents);
  const capCents = Math.floor((equityCents * allocationPercent) / 100);
  const headroomCents = Math.max(0, capCents - pairReservedCents);
  return {
    equityCents,
    capCents,
    headroomCents,
    spendableCents: Math.min(headroomCents, availableCents),
  };
}
