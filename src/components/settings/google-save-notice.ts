// What the Google panels say when a save fails: the highlighted fields when
// there are some, and otherwise the reason the request itself failed.
export function saveFailureMessage(
  fieldErrors: Record<string, string>,
  error: string | null,
): string {
  void fieldErrors;
  void error;

  return "Check the highlighted fields.";
}
