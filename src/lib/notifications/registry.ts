import type { IntegrationSettings } from "../integration-settings.ts";
import type { EnvSource } from "../utils/env.ts";
import type { NotificationChannel } from "./channel.ts";
import { createSlackChannel } from "./slack/channel.ts";

// The channels this install can send to. A new chat tool is one more entry
// here (and its setup section on the page); everything else goes by id.

let channels: NotificationChannel[] | null = null;

export function getNotificationChannels(): NotificationChannel[] {
  channels ??= [createSlackChannel()];

  return channels;
}

export function getNotificationChannel(id: string): NotificationChannel | null {
  return getNotificationChannels().find((channel) => channel.id === id) ?? null;
}

/** For the onboarding checklist: the channels that are set up, by name. */
export function describeNotificationSetup(
  env: EnvSource,
  stored: IntegrationSettings,
): { configured: string[] } {
  return {
    configured: getNotificationChannels()
      .filter((channel) => channel.status({ env, stored }).configured)
      .map((channel) => channel.name),
  };
}
