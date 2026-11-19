import type { ConnectionStatus } from "@/components/settings/integration-kit";
import {
  INTEGRATIONS,
  toConnectionStatus,
  type IntegrationId,
} from "@/components/settings/integrations-catalog";
import { getIntegrationSettings } from "@/lib/integration-settings";
import { describeNotificationSetup } from "@/lib/notifications/registry";
import { getOnboardingState } from "@/lib/onboarding/steps";

export type IntegrationState = { detail: string; status: ConnectionStatus };

/**
 * Where each integration stands, from the same checks as the onboarding
 * checklist. Slack is the exception: its onboarding step can be marked done
 * without it, so it is read from the notification channels themselves.
 */
export async function getIntegrationStates(): Promise<
  Record<IntegrationId, IntegrationState>
> {
  const [steps, stored] = await Promise.all([
    getOnboardingState(),
    getIntegrationSettings(),
  ]);
  const slack = describeNotificationSetup(process.env, stored).configured.some(
    (name) => name === "Slack",
  );
  const states = {} as Record<IntegrationId, IntegrationState>;

  for (const integration of INTEGRATIONS) {
    if (integration.id === "slack") {
      states.slack = slack
        ? { detail: "Connected to a Slack workspace.", status: "connected" }
        : { detail: "Nothing is sent to Slack yet.", status: "not_set_up" };
      continue;
    }

    const step = steps.find((item) => item.id === integration.step);

    states[integration.id] = step
      ? { detail: step.detail, status: toConnectionStatus(step.status) }
      : { detail: "", status: "not_set_up" };
  }

  return states;
}
