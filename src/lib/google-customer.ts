// The Workspace customer a directory is read for. "my_customer" is the
// organization the signed-in administrator or the app's own account belongs
// to, and what is used when no customer ID is saved.

export const OWN_GOOGLE_CUSTOMER = "my_customer";

/**
 * Whether the customer ID still has to be entered. With domain-wide
 * delegation the directory is read as an administrator of the Workspace,
 * so the ID can stay empty; with the administrator role it is needed.
 */
export function needsCustomerId(directory: {
  customer: string;
  mode: "admin-role" | "delegation";
}): boolean {
  return (
    directory.mode === "admin-role" &&
    directory.customer === OWN_GOOGLE_CUSTOMER
  );
}
