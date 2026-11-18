// How a DNS record's status from Resend reads in the setup table.
export function describeRecordStatus(status: string): string {
  return status === "verified" ? "Found" : "Not found yet";
}
