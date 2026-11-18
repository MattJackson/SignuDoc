import { toNextJsHandler } from "better-auth/next-js";

import { getCurrentAuth } from "@/lib/auth/server";
import { rejectBots } from "@/lib/security/botid";

type AppAuth = Awaited<ReturnType<typeof getCurrentAuth>>;
type AuthHandlers = ReturnType<typeof toNextJsHandler>;

const handlersByAuth = new WeakMap<AppAuth, AuthHandlers>();

// Built on the first request rather than at import time, so that `next build`
// does not need a database or auth secret to collect page data. The auth
// server is built again when an administrator changes how people sign in
// (getCurrentAuth), and its handlers with it.
async function getHandlers(): Promise<AuthHandlers> {
  const auth = await getCurrentAuth();
  let handlers = handlersByAuth.get(auth);

  if (!handlers) {
    handlers = toNextJsHandler(auth);
    handlersByAuth.set(auth, handlers);
  }

  return handlers;
}

export async function DELETE(request: Request) {
  return (await getHandlers()).DELETE(request);
}

export async function GET(request: Request) {
  return (await getHandlers()).GET(request);
}

export async function PATCH(request: Request) {
  return (await getHandlers()).PATCH(request);
}

export async function POST(request: Request) {
  // Sign-in, sign-up and the routes that send email are checked by BotID
  // first, where that is turned on.
  return (await rejectBots(request)) ?? (await getHandlers()).POST(request);
}

export async function PUT(request: Request) {
  return (await getHandlers()).PUT(request);
}
