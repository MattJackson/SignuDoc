import {
  type EnvelopeStatus,
  MAX_UPLOAD_SIZE_BYTES,
} from "../../../../types/domain.ts";
import { escapeHtml } from "../../../../utils/html.ts";
import type { AddInEnvelope } from "../../../add-in-envelopes.ts";
import type { AddonAction } from "./config.ts";
import type { GmailSender, SignableAttachment } from "./gmail.ts";

// The cards the add-on shows, as the JSON Google renders, and the responses
// that carry them. Card fields are Google's card schema
// (https://developers.google.com/workspace/add-ons/reference/rpc/google.apps.card.v1):
// a card has a header and sections of widgets (textParagraph,
// decoratedText, buttonList); a button's onClick either opens a link or
// calls an action, which for an HTTP add-on is the HTTPS URL to post to,
// with parameters that come back in commonEventObject.parameters.
//
// Responses are RenderActions
// (https://developers.google.com/workspace/add-ons/guides/alternate-runtimes):
// navigations that push or update a card, a notification, or, in Drive, a
// host action that asks the user to give the add-on a file.
//
// Everything here is plain data in and JSON out, so it is tested without a
// server. Text that came from someone else (a subject, a file name, a
// title) is escaped, since Google renders a little HTML in card text.

export type CardWidget = Record<string, unknown>;
export type CardSection = {
  collapsible?: boolean;
  header?: string;
  widgets: CardWidget[];
};
export type Card = {
  header?: { subtitle?: string; title: string };
  sections: CardSection[];
};

export type RenderActions = { renderActions: Record<string, unknown> };

/** What a button on a card asks the action endpoint to do. */
export type CardButtonAction =
  "nudge" | "request-file-scope" | "send-attachment" | "send-drive-file";

const TITLE_MAX = 120;
const MAX_UPLOAD_MB = MAX_UPLOAD_SIZE_BYTES / (1024 * 1024);

export const TOO_LARGE_MESSAGE = `The document is larger than ${String(MAX_UPLOAD_MB)} MB, the most SignuDoc takes.`;

const STATUS_LABELS: Record<EnvelopeStatus, string> = {
  completed: "Completed",
  declined: "Declined",
  draft: "Draft",
  sent: "Waiting for signatures",
  voided: "Voided",
};

const shortDate = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function clip(value: string, max = TITLE_MAX): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function text(value: string, max = TITLE_MAX): string {
  return escapeHtml(clip(value, max));
}

export function statusLabel(status: EnvelopeStatus): string {
  return STATUS_LABELS[status];
}

function paragraph(value: string): CardWidget {
  return { textParagraph: { text: value } };
}

function linkButton(label: string, url: string): CardWidget {
  return { onClick: { openLink: { url } }, text: label };
}

function actionButton(
  label: string,
  actionUrl: string,
  parameters: { action: CardButtonAction } & Record<string, string>,
): CardWidget {
  return {
    onClick: {
      action: {
        function: actionUrl,
        parameters: Object.entries(parameters).map(([key, value]) => ({
          key,
          value,
        })),
      },
    },
    text: label,
  };
}

function buttons(...list: CardWidget[]): CardWidget {
  return { buttonList: { buttons: list } };
}

/** Shows a card as the add-on's first one (triggers) or on top (actions). */
export function pushCard(card: Card): RenderActions {
  return { renderActions: { action: { navigations: [{ pushCard: card }] } } };
}

/** Replaces the card on show, with a short message if given. */
export function updateCard(card: Card, notification?: string): RenderActions {
  return {
    renderActions: {
      action: {
        navigations: [{ updateCard: card }],
        ...(notification ? { notification: { text: notification } } : {}),
      },
    },
  };
}

/** Just a short message at the bottom of the panel. */
export function notify(message: string): RenderActions {
  return {
    renderActions: { action: { notification: { text: clip(message, 200) } } },
  };
}

/**
 * The answer for a person who has made too many requests. Only an action may
 * answer with a bare message; the homepage and contextual triggers must
 * show a card.
 */
export function rateLimitedResponse(action: AddonAction): RenderActions {
  return action === "action"
    ? notify("Too many requests. Try again in a minute.")
    : pushCard(messageCard("Too many requests", "Try again in a minute."));
}

/**
 * Asks Drive to show its dialog that gives the add-on one file (drive.file).
 * The RenderActions host action for Drive, requestFileScope with the item.
 */
export function requestFileScope(itemId: string): RenderActions {
  return {
    renderActions: {
      hostAppAction: { driveAction: { requestFileScope: { itemId } } },
    },
  };
}

function header(subtitle?: string) {
  return {
    title: "SignuDoc",
    ...(subtitle ? { subtitle: clip(subtitle, 80) } : {}),
  };
}

export type SiteLinks = {
  /** The URL the add-on's buttons post to. */
  actionUrl: string;
  /** This site's address, without a trailing slash. */
  siteUrl: string;
};

export function envelopeUrl(siteUrl: string, envelopeId: string): string {
  return `${siteUrl}/envelopes/${encodeURIComponent(envelopeId)}`;
}

/** Something the add-on cannot do for this person, with a way forward. */
export function messageCard(
  title: string,
  body: string,
  action?: { label: string; url: string },
): Card {
  return {
    header: header(title),
    sections: [
      {
        widgets: [
          paragraph(escapeHtml(body)),
          ...(action ? [buttons(linkButton(action.label, action.url))] : []),
        ],
      },
    ],
  };
}

export type SignInReason = "no_account" | "outside_workspace" | "unverified";

/** For someone the add-on cannot match to an account. */
export function signInCard(siteUrl: string, reason: SignInReason): Card {
  switch (reason) {
    case "no_account":
      return messageCard(
        "Sign in to start",
        "You do not have a SignuDoc account yet. Sign in to SignuDoc once, then come back here.",
        { label: "Sign in to SignuDoc", url: `${siteUrl}/login` },
      );
    case "unverified":
      return messageCard(
        "Verify your email",
        "Your SignuDoc account's email address is not verified yet. Sign in to SignuDoc to finish, then come back here.",
        { label: "Open SignuDoc", url: `${siteUrl}/login` },
      );
    case "outside_workspace":
      return messageCard(
        "Not available",
        "This add-on is for your organization's Google Workspace accounts.",
      );
  }
}

function envelopeWidgets(
  envelope: AddInEnvelope,
  links: SiteLinks,
): CardWidget[] {
  const widgets: CardWidget[] = [
    {
      decoratedText: {
        bottomLabel: `Updated ${shortDate.format(new Date(envelope.updatedAt * 1000))}`,
        button: linkButton("Open", envelopeUrl(links.siteUrl, envelope.id)),
        text: text(envelope.title),
        topLabel: statusLabel(envelope.status),
        wrapText: true,
      },
    },
  ];

  if (envelope.canNudge) {
    widgets.push(
      buttons(
        actionButton("Nudge", links.actionUrl, {
          action: "nudge",
          envelopeId: envelope.id,
        }),
      ),
    );
  }

  return widgets;
}

export type GmailCardInput = {
  attachments: SignableAttachment[];
  envelopes: AddInEnvelope[];
  links: SiteLinks;
  sender: GmailSender | null;
  subject: string;
};

/** The card beside an open email: its documents, and envelopes with its sender. */
export function gmailMessageCard({
  attachments,
  envelopes,
  links,
  sender,
  subject,
}: GmailCardInput): Card {
  const documentWidgets: CardWidget[] =
    attachments.length === 0
      ? [paragraph("This email has no PDF or Word attachment to send.")]
      : attachments.map((attachment) => ({
          decoratedText: {
            bottomLabel: attachment.tooLarge
              ? `Too large to send (${String(MAX_UPLOAD_MB)} MB at most)`
              : attachment.mimeType === "application/pdf"
                ? "PDF"
                : "Word, converted to PDF",
            ...(attachment.tooLarge
              ? {}
              : {
                  // The message is always the one open, never one named by
                  // the button: the event's token reaches only that one.
                  button: actionButton("Send for signature", links.actionUrl, {
                    action: "send-attachment",
                    partId: attachment.partId,
                  }),
                }),
            text: text(attachment.fileName),
            wrapText: true,
          },
        }));
  const sections: CardSection[] = [
    { header: "Documents in this email", widgets: documentWidgets },
  ];

  if (sender) {
    sections.push({
      header: clip(`Your envelopes with ${sender.name ?? sender.email}`, 80),
      widgets:
        envelopes.length > 0
          ? envelopes.flatMap((envelope) => envelopeWidgets(envelope, links))
          : [
              paragraph(
                escapeHtml(
                  `You have not sent anything to ${sender.email} yet.`,
                ),
              ),
            ],
    });
  }

  return { header: header(clip(subject, 80)), sections };
}

export type DriveCardItem = {
  envelopes: AddInEnvelope[];
  hasFileScope: boolean;
  id: string;
  sendable: boolean;
  title: string;
};

/** The card for files selected in Drive. */
export function driveItemsCard(items: DriveCardItem[], links: SiteLinks): Card {
  if (items.length === 0) {
    return homepageCard(links.siteUrl, "drive");
  }

  const sections = items.slice(0, 5).map((item): CardSection => {
    const widgets: CardWidget[] = [];

    if (!item.sendable) {
      widgets.push(
        paragraph(
          `${text(item.title)}: only PDFs, documents, spreadsheets and presentations can be sent for signature.`,
        ),
      );
    } else if (!item.hasFileScope) {
      widgets.push(
        paragraph(
          "To send this file, let SignuDoc open it. Google asks you once, for this file only.",
        ),
        buttons(
          actionButton("Allow access to this file", links.actionUrl, {
            action: "request-file-scope",
            fileId: item.id,
          }),
        ),
      );
    } else {
      widgets.push(
        buttons(
          actionButton("Send for signature", links.actionUrl, {
            action: "send-drive-file",
            fileId: item.id,
          }),
        ),
      );
    }

    if (item.envelopes.length > 0) {
      widgets.push(
        paragraph("<b>Your envelopes from this file</b>"),
        ...item.envelopes.flatMap((envelope) =>
          envelopeWidgets(envelope, links),
        ),
      );
    }

    return { header: clip(item.title, 80), widgets };
  });

  return { header: header("Send for signature"), sections };
}

/** What the add-on shows with nothing open or selected. */
export function homepageCard(
  siteUrl: string,
  hostApp: "drive" | "gmail" | "other",
): Card {
  const hint =
    hostApp === "drive"
      ? "Select a PDF, a document or a Google Doc to send it for signature."
      : hostApp === "gmail"
        ? "Open an email with a PDF or Word attachment to send it for signature, and see your envelopes with its sender."
        : "Send documents for signature from Gmail and Google Drive.";

  return {
    header: header(),
    sections: [
      {
        widgets: [
          paragraph(hint),
          buttons(
            linkButton("Open dashboard", `${siteUrl}/dashboard`),
            linkButton("New envelope", `${siteUrl}/envelopes/new`),
          ),
        ],
      },
    ],
  };
}

/** After a draft was made: where to choose signers, place fields and send. */
export function draftCreatedCard(input: {
  fileName: string;
  suggestedSigner: GmailSender | null;
  /** The draft's next page on this site. */
  url: string;
}): Card {
  const lines = [
    `<b>${text(input.fileName)}</b> is a draft in SignuDoc.`,
    input.suggestedSigner
      ? `${text(input.suggestedSigner.name ?? input.suggestedSigner.email)} (${text(input.suggestedSigner.email)}) is its first signer; change that on the next page if needed.`
      : "Add the signers, place the fields, and send it.",
  ];

  return {
    header: header("Draft ready"),
    sections: [
      {
        widgets: [
          paragraph(lines.join("<br>")),
          buttons(linkButton("Prepare and send", input.url)),
        ],
      },
    ],
  };
}
