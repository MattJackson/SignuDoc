import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  getNotificationsAdminView,
  listSlackChannels,
  NotificationSaveError,
  saveNotificationSettings,
  sendSlackTestMessage,
  testSlackConnection,
} from "@/lib/notifications/settings";
import { slackChannelIdSchema } from "@/lib/notifications/slack/channel";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";

// Settings, Notifications: the Slack connection, direct messages, the
// job's thresholds, and the checks an administrator can run (test the
// token, list channels, send a test message). Administrators only. Rules
// are under ./rules.

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test_slack") }),
  z.object({ action: z.literal("list_slack_channels") }),
  z.object({
    action: z.literal("test_slack_message"),
    channel: slackChannelIdSchema.optional(),
  }),
]);

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "notification_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the notification settings.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

async function limit(request: Request, userId: string) {
  return applyRateLimit({
    category: "notification_settings",
    key: buildRateLimitKey(["notification-settings", userId]),
    limit: 30,
    request,
    userId,
    windowMs: 10 * 60 * 1000,
  });
}

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json({ view: await getNotificationsAdminView() });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function PUT(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await limit(request, session.user.id);

  if (limited) {
    return limited;
  }

  try {
    const view = await saveNotificationSettings(
      await request.json().catch(() => null),
      {
        email: session.user.email,
        id: session.user.id,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
      },
    );

    return NextResponse.json({ view });
  } catch (error) {
    if (error instanceof NotificationSaveError) {
      return NextResponse.json(
        { error: error.message, fieldErrors: error.fieldErrors },
        { status: 400 },
      );
    }

    return failure(request, error, session.user.id);
  }
}

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await limit(request, session.user.id);

  if (limited) {
    return limited;
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    switch (parsed.data.action) {
      case "test_slack":
        return NextResponse.json({ result: await testSlackConnection() });
      case "list_slack_channels":
        return NextResponse.json({ result: await listSlackChannels() });
      case "test_slack_message":
        return NextResponse.json({
          result: await sendSlackTestMessage(
            parsed.data.channel
              ? { channel: parsed.data.channel }
              : { email: session.user.email },
          ),
        });
    }
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
