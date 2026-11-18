import { after } from "next/server";

import { peekIntegrationSettings } from "../integration-settings.ts";
import { onAuditEventCommitted } from "../services/audit.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import { runNotificationJob } from "./job.ts";
import { SLACK_TOKEN_SETTING } from "./slack/channel.ts";

// Delivery soon after something happens, instead of waiting for the next
// scheduled run. Once the server starts (instrumentation.ts), every
// committed envelope audit event asks for a short run of the outbox after
// the response has gone (after(), which keeps a Vercel function alive
// until it is done). Only one run goes at a time in an instance; asking
// while one is going makes it go round once more.
//
// This is only a shortcut. The events are already queued in the database,
// so a run that never happens (a function stopped early, an instance that
// went away) is made up for by the next request or the scheduled run.

const RUN_BUDGET_MS = 15_000;

type KickState = { again: boolean; registered: boolean; running: boolean };

declare global {
  var __signudocNotificationKick: KickState | undefined;
}

function state(): KickState {
  globalThis.__signudocNotificationKick ??= {
    again: false,
    registered: false,
    running: false,
  };

  return globalThis.__signudocNotificationKick;
}

/**
 * Whether a channel might be set up, without asking the database. True
 * while the settings have not been read in this instance yet: the run
 * itself finds out.
 */
function mightHaveChannel(env: EnvSource): boolean {
  if (readEnv(env, "SLACK_BOT_TOKEN")) {
    return true;
  }

  const stored = peekIntegrationSettings();

  return stored === null || Boolean(stored[SLACK_TOKEN_SETTING]);
}

async function runUntilCaughtUp() {
  const current = state();

  if (current.running) {
    current.again = true;
    return;
  }

  current.running = true;

  try {
    do {
      current.again = false;
      await runNotificationJob({
        deadline: Date.now() + RUN_BUDGET_MS,
        detectConditions: false,
      });
    } while (current.again);
  } catch (error) {
    console.warn(
      "[notifications] Delivering notifications failed; the next run tries again:",
      error instanceof Error ? error.message : error,
    );
  } finally {
    current.running = false;
  }
}

export function requestNotificationDelivery(env: EnvSource = process.env) {
  if (!mightHaveChannel(env)) {
    return;
  }

  try {
    after(runUntilCaughtUp);
  } catch {
    // Not inside a request: nothing to wait for.
    void runUntilCaughtUp();
  }
}

/** Called once when the server starts. */
export function registerNotificationDelivery() {
  const current = state();

  if (current.registered) {
    return;
  }

  current.registered = true;
  onAuditEventCommitted(() => {
    requestNotificationDelivery();
  });
}
