// The Slack app manifest shown on the setup page, for "Create New App, From
// a manifest" at https://api.slack.com/apps. It asks for as little as
// notifications need:
//
// * chat:write: post the messages, to people and to channels the app has
//   been invited to. Without chat:write.public it cannot post anywhere it
//   was not invited, which keeps a rule from reaching a channel nobody
//   added it to.
// * users:read and users:read.email: find a person's Slack account from
//   their email address (users.lookupByEmail), for direct messages. Slack
//   only grants users:read.email together with users:read.
// * channels:read: list public channels to pick from when making a rule.
//   A private channel is pasted by its ID instead, so groups:read is not
//   asked for.
//
// The app has no events, slash commands or interactivity: it only sends.
// The messages tab of its App Home is on, read-only, because that is where
// Slack shows the app's direct messages.

export const SLACK_BOT_SCOPES = [
  "chat:write",
  "users:read",
  "users:read.email",
  "channels:read",
] as const;

export function buildSlackManifest({
  appName,
  siteUrl,
}: {
  appName: string;
  siteUrl: string | null;
}): Record<string, unknown> {
  const name = appName.trim().slice(0, 35) || "SignuDoc";
  let host: string | null = null;

  try {
    host = siteUrl ? new URL(siteUrl).host : null;
  } catch {
    host = null;
  }

  const description = (
    host
      ? `Notifications about documents sent for signature on ${host}.`
      : "Notifications about documents sent for signature."
  ).slice(0, 140);

  return {
    display_information: {
      background_color: "#1f2937",
      description,
      name,
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: true,
      },
      bot_user: {
        always_online: true,
        display_name: name,
      },
    },
    oauth_config: {
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
