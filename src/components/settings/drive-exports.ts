// The export list from a list_exports reply, or null when the reply is not
// a list (a failed request), so the panel can say so.
export function readExports<T>(
  payload: { exports?: T[] } | null | undefined,
): T[] | null {
  const list = payload?.exports;

  return Array.isArray(list) ? list : null;
}

// What the executed-copies section shows for the list it has and whether
// the last load failed.
export function exportsView(
  list: unknown[] | null,
  failed: boolean,
): "empty" | "failed" | "list" | "loading" {
  if (list === null) {
    return failed ? "failed" : "loading";
  }

  return list.length === 0 ? "empty" : "list";
}
