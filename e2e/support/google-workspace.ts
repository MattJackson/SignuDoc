// The fake Google Workspace the end-to-end test signs in with: who is in
// it and which group makes administrators. Read by the stand-in
// (google-stand-in.ts), by playwright.config.ts for the app's settings, and
// by the test (workspace.spec.ts).

export const WORKSPACE_DOMAIN = "acme.example";
export const ADMIN_GROUP = `signudoc-admins@${WORKSPACE_DOMAIN}`;

export const PEOPLE = {
  admin: {
    email: `dana.admin@${WORKSPACE_DOMAIN}`,
    familyName: "Admin",
    givenName: "Dana",
  },
  colleague: {
    email: `daniel.diaz@${WORKSPACE_DOMAIN}`,
    familyName: "Diaz",
    givenName: "Daniel",
  },
  sender: {
    email: `sam.sender@${WORKSPACE_DOMAIN}`,
    familyName: "Sender",
    givenName: "Sam",
  },
  // Not offered as a suggestion.
  suspended: {
    email: `dan.gone@${WORKSPACE_DOMAIN}`,
    familyName: "Gone",
    givenName: "Dan",
    suspended: true,
  },
} as const;

export const GROUPS = [
  {
    email: ADMIN_GROUP,
    // Through a nested group as well as directly.
    members: [PEOPLE.admin.email, `it-leads@${WORKSPACE_DOMAIN}`],
    name: "SignuDoc administrators",
  },
  {
    email: `it-leads@${WORKSPACE_DOMAIN}`,
    members: [PEOPLE.colleague.email],
    name: "IT leads",
  },
];
