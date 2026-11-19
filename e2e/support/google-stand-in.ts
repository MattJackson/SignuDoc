// The fake Google server (src/lib/integrations/google/test-support) for the
// end-to-end test, with the Workspace in google-workspace.ts. The app under
// test reaches it through GOOGLE_OAUTH_BASE_URL and GOOGLE_API_BASE_URL.
// The service account key the app is given arrives in
// E2E_GOOGLE_SERVICE_ACCOUNT_KEY, so its assertions are checked against it,
// and the OAuth client in E2E_GOOGLE_CLIENT_ID and E2E_GOOGLE_CLIENT_SECRET.
// Runs until stopped.

import { startFakeGoogle } from "../../src/lib/integrations/google/test-support/fake-google.ts";
import { GROUPS, PEOPLE, WORKSPACE_DOMAIN } from "./google-workspace.ts";

const port = Number(process.env.E2E_GOOGLE_PORT ?? 3102);
const serviceAccountKey = process.env.E2E_GOOGLE_SERVICE_ACCOUNT_KEY;
const clientId = process.env.E2E_GOOGLE_CLIENT_ID;
const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET;
const google = await startFakeGoogle({
  ...(clientId && clientSecret
    ? { clients: [{ id: clientId, secret: clientSecret }] }
    : {}),
  directoryDomains: [WORKSPACE_DOMAIN],
  groups: GROUPS.map((group) => ({ ...group, members: [...group.members] })),
  port,
  serviceAccounts: serviceAccountKey
    ? [
        JSON.parse(serviceAccountKey) as {
          client_email: string;
          private_key: string;
        },
      ]
    : [],
  users: Object.values(PEOPLE).map((person) => ({ ...person })),
});

console.log(`[google stand-in] fake Google at ${google.url}`);

async function stop() {
  await google.close();
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
