import assert from "node:assert/strict";
import { test } from "node:test";

import type { AddInEnvelope } from "../../../add-in-envelopes.ts";
import {
  draftCreatedCard,
  driveItemsCard,
  gmailMessageCard,
  pushCard,
  rateLimitedResponse,
  requestFileScope,
  signInCard,
  updateCard,
  type Card,
} from "./cards.ts";
import { buildAddonDeployment, deploymentCommands } from "./manifest.ts";

// The cards are plain JSON; these check the parts Google and the handlers
// depend on: where buttons post, what they carry, and that text from an
// email or a file is escaped.

const links = {
  actionUrl: "https://sign.example.test/api/workspace/add-in/action",
  siteUrl: "https://sign.example.test",
};

function envelope(overrides: Partial<AddInEnvelope> = {}): AddInEnvelope {
  return {
    canNudge: false,
    id: "env-1",
    status: "sent",
    title: "Master services agreement",
    updatedAt: 1_800_000_000,
    ...overrides,
  };
}

/** Every button on a card, wherever it sits. */
function buttonsOf(card: Card): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];

  function walk(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value !== "object" || value === null) {
      return;
    }

    const record = value as Record<string, unknown>;

    if (typeof record.text === "string" && "onClick" in record) {
      found.push(record);
    }

    Object.values(record).forEach(walk);
  }

  walk(card);

  return found;
}

function parametersOf(button: Record<string, unknown>) {
  const action = (
    button.onClick as {
      action?: {
        function: string;
        parameters: { key: string; value: string }[];
      };
    }
  ).action;

  return action
    ? {
        function: action.function,
        parameters: Object.fromEntries(
          action.parameters.map((entry) => [entry.key, entry.value]),
        ),
      }
    : null;
}

test("an email's documents can each be sent, and its sender's envelopes listed", () => {
  const card = gmailMessageCard({
    attachments: [
      {
        attachmentId: "att-1",
        fileName: "<b>Offer</b>.pdf",
        mimeType: "application/pdf",
        partId: "2",
        sizeBytes: 1000,
        tooLarge: false,
      },
      {
        attachmentId: "att-2",
        fileName: "huge.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        partId: "3",
        sizeBytes: 30_000_000,
        tooLarge: true,
      },
    ],
    envelopes: [
      envelope({ canNudge: true }),
      envelope({ id: "env-2", status: "completed" }),
    ],
    links,
    sender: { email: "pat@client.example", name: "Pat Client" },
    subject: "Your offer",
  });
  const json = JSON.stringify(card);
  const buttons = buttonsOf(card);
  const send = buttons.filter((button) => button.text === "Send for signature");

  // The large one cannot be sent, so only one button. It names the part,
  // never the message: that is always the one open.
  assert.equal(send.length, 1);
  assert.deepEqual(parametersOf(send[0]!), {
    function: links.actionUrl,
    parameters: { action: "send-attachment", partId: "2" },
  });
  assert.ok(json.includes("&lt;b&gt;Offer&lt;/b&gt;.pdf"));
  assert.ok(!json.includes("<b>Offer</b>"));
  assert.ok(json.includes("Too large to send"));
  assert.ok(json.includes("Your envelopes with Pat Client"));

  const nudges = buttons.filter((button) => button.text === "Nudge");

  // Only the envelope that is waiting.
  assert.equal(nudges.length, 1);
  assert.deepEqual(parametersOf(nudges[0]!)?.parameters, {
    action: "nudge",
    envelopeId: "env-1",
  });
  assert.ok(json.includes("https://sign.example.test/envelopes/env-2"));
});

test("without a sender there is no envelopes section", () => {
  const card = gmailMessageCard({
    attachments: [],
    envelopes: [],
    links,
    sender: null,
    subject: "No documents",
  });

  assert.equal(card.sections.length, 1);
  assert.ok(JSON.stringify(card).includes("no PDF or Word attachment"));
});

test("a Drive file asks for access first, then can be sent", () => {
  const card = driveItemsCard(
    [
      {
        envelopes: [],
        hasFileScope: false,
        id: "f-1",
        sendable: true,
        title: "A.pdf",
      },
      {
        envelopes: [envelope({ status: "draft" })],
        hasFileScope: true,
        id: "f-2",
        sendable: true,
        title: "B",
      },
      {
        envelopes: [],
        hasFileScope: true,
        id: "f-3",
        sendable: false,
        title: "C.zip",
      },
    ],
    links,
  );
  const buttons = buttonsOf(card);
  const allow = buttons.find(
    (button) => button.text === "Allow access to this file",
  );
  const send = buttons.find((button) => button.text === "Send for signature");

  assert.deepEqual(parametersOf(allow!)?.parameters, {
    action: "request-file-scope",
    fileId: "f-1",
  });
  assert.deepEqual(parametersOf(send!)?.parameters, {
    action: "send-drive-file",
    fileId: "f-2",
  });
  assert.ok(JSON.stringify(card).includes("Your envelopes from this file"));
  assert.ok(JSON.stringify(card).includes("only PDFs, documents"));
});
test("responses are Google's RenderActions", () => {
  const card = signInCard(links.siteUrl, "no_account");

  assert.deepEqual(pushCard(card), {
    renderActions: { action: { navigations: [{ pushCard: card }] } },
  });
  assert.deepEqual(updateCard(card, "Done"), {
    renderActions: {
      action: {
        navigations: [{ updateCard: card }],
        notification: { text: "Done" },
      },
    },
  });
  assert.deepEqual(requestFileScope("f-1"), {
    renderActions: {
      hostAppAction: { driveAction: { requestFileScope: { itemId: "f-1" } } },
    },
  });
  assert.ok(JSON.stringify(card).includes("https://sign.example.test/login"));
});

test("a new draft links to its next page and names the suggested signer", () => {
  const card = draftCreatedCard({
    fileName: "Offer.pdf",
    suggestedSigner: { email: "pat@client.example", name: "Pat Client" },
    url: "https://sign.example.test/envelopes/env-9/signers",
  });
  const json = JSON.stringify(card);

  assert.ok(json.includes("https://sign.example.test/envelopes/env-9/signers"));
  assert.ok(json.includes("Pat Client (pat@client.example)"));
});
/** The text of every paragraph on a card, which Google reads as HTML. */
function paragraphsOf(card: Card): string[] {
  const found: string[] = [];

  function walk(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value !== "object" || value === null) {
      return;
    }

    const record = value as Record<string, unknown>;

    if (typeof record.textParagraph === "object" && record.textParagraph) {
      found.push(String((record.textParagraph as { text?: unknown }).text));
    }

    Object.values(record).forEach(walk);
  }

  walk(card);

  return found;
}

test("a Drive file name cannot add markup to a card", () => {
  const name = '<a href="https://x">x</a>';
  const unsupported = paragraphsOf(
    driveItemsCard(
      [
        {
          envelopes: [],
          hasFileScope: true,
          id: "f-1",
          sendable: false,
          title: name,
        },
      ],
      links,
    ),
  ).join("\n");
  const drafted = paragraphsOf(
    draftCreatedCard({
      fileName: name,
      suggestedSigner: null,
      url: "https://sign.example.test/envelopes/env-9/signers",
    }),
  ).join("\n");

  for (const shown of [unsupported, drafted]) {
    assert.ok(shown.includes("&lt;a "));
    assert.ok(!shown.includes("<a "));
  }
});
test("the deployment names this site's URLs, its scopes and the system ID token", () => {
  const deployment = buildAddonDeployment({
    name: "Example Inc SignuDoc",
    siteUrl: "https://sign.example.test/",
  });

  assert.equal(
    deployment.addOns.common.homepageTrigger.runFunction,
    "https://sign.example.test/api/workspace/add-in/homepage",
  );
  assert.equal(
    deployment.addOns.gmail.contextualTriggers[0]!.onTriggerFunction,
    "https://sign.example.test/api/workspace/add-in/gmail-message",
  );
  assert.equal(
    deployment.addOns.drive.onItemsSelectedTrigger.runFunction,
    "https://sign.example.test/api/workspace/add-in/drive-items",
  );
  assert.equal(
    deployment.addOns.httpOptions.authorizationHeader,
    "SYSTEM_ID_TOKEN",
  );
  assert.deepEqual(deployment.addOns.common.openLinkUrlPrefixes, [
    "https://sign.example.test/",
  ]);
  assert.ok(
    deployment.oauthScopes.includes(
      "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
    ),
  );
  assert.ok(
    deployment.oauthScopes.includes(
      "https://www.googleapis.com/auth/drive.file",
    ),
  );
  // Nothing broader than one file, or the open message.
  assert.ok(
    !deployment.oauthScopes.includes("https://www.googleapis.com/auth/drive"),
  );
  assert.ok(
    deploymentCommands().some((entry) =>
      entry.command.startsWith(
        "gcloud workspace-add-ons deployments create signudoc",
      ),
    ),
  );
});

test("a rate-limited person gets a card from every trigger but an action", () => {
  for (const trigger of ["homepage", "gmail-message", "drive-items"] as const) {
    const actions = rateLimitedResponse(trigger).renderActions as {
      action: { navigations?: { pushCard: Card }[]; notification?: unknown };
    };

    assert.equal(actions.action.navigations?.length, 1);
    assert.ok(actions.action.navigations?.[0]?.pushCard);
    assert.equal(actions.action.notification, undefined);
  }

  const action = rateLimitedResponse("action").renderActions as {
    action: { notification?: { text: string } };
  };

  assert.match(action.action.notification?.text ?? "", /Too many requests/);
});
