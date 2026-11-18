// Runs once when a server instance starts, before it handles any request.
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Settings saved in the app (a Resend key above all) are read now, so the
  // first request already knows about them. See integration-settings.ts.
  const { primeIntegrationSettings } =
    await import("@/lib/integration-settings");

  await primeIntegrationSettings();

  // Notifications go out soon after the audit event they are about, not
  // only on the scheduled run. See notifications/kick.ts.
  const { registerNotificationDelivery } =
    await import("@/lib/notifications/kick");

  registerNotificationDelivery();
}
