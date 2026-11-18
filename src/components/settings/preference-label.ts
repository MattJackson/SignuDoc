// The accessible name of a notification preference checkbox: the row's
// visible label, then which envelopes it covers.
export function preferenceCheckboxLabel(
  label: string,
  scope: "own" | "team",
): string {
  return `${label}, ${scope === "own" ? "for my envelopes" : "for my teams' envelopes"}`;
}
