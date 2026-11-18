// The fake Google Workspace the end-to-end test signs in with: who is in
// it, which group makes administrators, and the accounts that must be
// turned away. Read by the stand-in (google-stand-in.ts), by
// playwright.config.ts for the app's settings, and by the test.

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
    manager: `dana.admin@${WORKSPACE_DOMAIN}`,
  },
  // In another organization's Workspace: hd is other.example.
  otherWorkspace: {
    email: "olga.other@other.example",
    familyName: "Other",
    givenName: "Olga",
  },
  // A personal Google account: no hd at all.
  personal: {
    email: "pat.personal@gmail.example",
    familyName: "Personal",
    givenName: "Pat",
    hd: null,
  },
  sender: {
    email: `sam.sender@${WORKSPACE_DOMAIN}`,
    familyName: "Sender",
    givenName: "Sam",
    manager: `dana.admin@${WORKSPACE_DOMAIN}`,
  },
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
