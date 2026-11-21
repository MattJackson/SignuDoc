// How a DNS record's status from Resend reads in the setup table.
export function describeRecordStatus(status: string): string {
  switch (status) {
    case "verified":
      return "Found";
    case "failed":
      return "Does not match, check the value";
    case "temporary_failure":
      return "Could not check, try again";
    default:
      return "Not found yet";
  }
}
