// A path on this site to send someone back to after a detour (signing in,
// connecting Google Drive), from a value the browser sent. Only a path on
// this same site is accepted: never another site, nor a "//host" address
// that a browser would read as one.

function hasSpaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 32 || code === 127) {
      return true;
    }
  }

  return false;
}

export function safeReturnPath(value: unknown, fallback: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.length > 2000 ||
    hasSpaceOrControl(value)
  ) {
    return fallback;
  }

  return value;
}
