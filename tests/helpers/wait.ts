/**
 * Poll a predicate until it becomes true or the timeout expires. Returns the
 * final boolean, so a failing condition becomes a normal assertion failure
 * rather than a Vitest timeout.
 */
export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
