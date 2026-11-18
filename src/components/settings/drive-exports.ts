// The export list from a list_exports reply, or null when the reply is not
// a list (a failed request), so the panel can say so.
export function readExports<T>(
  payload: { exports?: T[] } | null | undefined,
): T[] | null {
  return payload?.exports ?? [];
}
