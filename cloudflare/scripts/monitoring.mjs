export function missedSamplingWindow(previousAt, currentAt, expectedDelayMs, toleranceMs = 60_000) {
  if (previousAt === undefined) return false;
  const elapsed = currentAt - previousAt;
  return elapsed < 0 || elapsed > expectedDelayMs + toleranceMs;
}
