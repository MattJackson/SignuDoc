import { DRIVE_API_BASE_URL, driveJson, type FetchLike } from "./drive-api.ts";
import type { LabelFieldMapping, LabelValueSource } from "./drive-config.ts";

// Drive labels on executed copies: an administrator picks a label (made in
// the Admin console, under Labels) and says which envelope value goes into
// each of its fields. After the upload, the label is put on the signed PDF
// with files.modifyLabels.
//
// Text fields take the value as it is; date fields take the completed
// date; person fields take an email address; a selection field takes the
// choice whose name matches the value. A field whose type does not fit its
// value, or has no value for this envelope, is left alone and reported.
// https://developers.google.com/workspace/drive/labels/guides/set-label

export const DRIVE_LABELS_BASE_URL = "https://drivelabels.googleapis.com/v2";

export type LabelValues = Record<LabelValueSource, string | null>;

export type DriveLabelChoice = {
  id: string;
  properties?: { displayName?: string };
};

export type DriveLabelField = {
  dateOptions?: object;
  id: string;
  integerOptions?: object;
  properties?: { displayName?: string };
  selectionOptions?: { choices?: DriveLabelChoice[] };
  textOptions?: object;
  userOptions?: object;
};

export type DriveLabel = {
  fields?: DriveLabelField[];
  id: string;
  name?: string;
  properties?: { title?: string };
};

export type FieldModification = {
  fieldId: string;
  setDateValues?: string[];
  setSelectionValues?: string[];
  setTextValues?: string[];
  setUserValues?: string[];
};

export type LabelFieldKind = "date" | "integer" | "selection" | "text" | "user";

export function fieldKind(field: DriveLabelField): LabelFieldKind | null {
  if (field.textOptions) return "text";
  if (field.dateOptions) return "date";
  if (field.selectionOptions) return "selection";
  if (field.userOptions) return "user";
  if (field.integerOptions) return "integer";

  return null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The changes to make for one envelope, and the fields that had to be left
 * alone (with why), from the label's fields and the administrator's
 * mapping.
 */
export function buildLabelModification(
  label: DriveLabel,
  mapping: LabelFieldMapping,
  values: LabelValues,
): { fieldModifications: FieldModification[]; skipped: string[] } {
  const fieldModifications: FieldModification[] = [];
  const skipped: string[] = [];

  for (const [fieldId, source] of Object.entries(mapping)) {
    const field = label.fields?.find((item) => item.id === fieldId);
    const name = field?.properties?.displayName ?? fieldId;
    const value = values[source]?.trim() || null;

    if (!field) {
      skipped.push(`${name}: no longer on the label`);
      continue;
    }

    if (!value) {
      skipped.push(`${name}: no value for this envelope`);
      continue;
    }

    switch (fieldKind(field)) {
      case "text":
        fieldModifications.push({
          fieldId,
          setTextValues: [value.slice(0, 1000)],
        });
        break;
      case "date": {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

        if (date) {
          fieldModifications.push({ fieldId, setDateValues: [date] });
        } else {
          skipped.push(`${name}: a date field needs a date`);
        }
        break;
      }
      case "user":
        if (EMAIL_PATTERN.test(value)) {
          fieldModifications.push({ fieldId, setUserValues: [value] });
        } else {
          skipped.push(`${name}: a person field needs an email address`);
        }
        break;
      case "selection": {
        const choice = field.selectionOptions?.choices?.find(
          (item) =>
            item.properties?.displayName?.trim().toLowerCase() ===
            value.toLowerCase(),
        );

        if (choice) {
          fieldModifications.push({ fieldId, setSelectionValues: [choice.id] });
        } else {
          skipped.push(`${name}: no choice named "${value.slice(0, 60)}"`);
        }
        break;
      }
      default:
        skipped.push(`${name}: this kind of field is not filled in`);
    }
  }

  return { fieldModifications, skipped };
}

export type SignerForCounterparty = {
  email: string;
  name: string | null;
  role: string;
};

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * The counterparty: the first signer, in signing order, whose address is
 * outside the organization's Workspace domains. With no domains known,
 * outside the sender's own domain.
 */
export function findCounterparty(
  signers: readonly SignerForCounterparty[],
  workspaceDomains: readonly string[],
  senderEmail: string,
): { email: string; name: string | null } | null {
  const inside = new Set(
    (workspaceDomains.length > 0
      ? workspaceDomains
      : [domainOf(senderEmail)]
    ).map((domain) => domain.toLowerCase()),
  );
  const signer = signers.find(
    (item) => item.role === "signer" && !inside.has(domainOf(item.email)),
  );

  return signer ? { email: signer.email, name: signer.name } : null;
}

/** The values a label field can be filled from, for one envelope. */
export function buildLabelValues(input: {
  completedAt: number;
  counterparty: { email: string; name: string | null } | null;
  envelopeId: string;
  senderEmail: string;
  senderName: string | null;
  senderTeams: readonly string[];
  title: string;
}): LabelValues {
  return {
    completedDate: new Date(input.completedAt * 1000)
      .toISOString()
      .slice(0, 10),
    counterparty: input.counterparty
      ? input.counterparty.name?.trim() || input.counterparty.email
      : null,
    counterpartyEmail: input.counterparty?.email ?? null,
    envelopeId: input.envelopeId,
    senderEmail: input.senderEmail,
    senderName: input.senderName?.trim() || null,
    senderTeam:
      input.senderTeams.length > 0 ? input.senderTeams.join(", ") : null,
    title: input.title,
  };
}

/** Published labels the caller may apply, for the administrator to pick. */
export async function listDriveLabels(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveLabel[]> {
  const params = new URLSearchParams({
    pageSize: "100",
    publishedOnly: "true",
    view: "LABEL_VIEW_FULL",
  });
  const body = await driveJson<{ labels?: DriveLabel[] }>(
    fetchImpl,
    accessToken,
    "Listing Drive labels",
    `${DRIVE_LABELS_BASE_URL}/labels?${params.toString()}`,
  );

  return body.labels ?? [];
}

export async function getDriveLabel(
  labelId: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveLabel> {
  return driveJson<DriveLabel>(
    fetchImpl,
    accessToken,
    "Reading the Drive label",
    `${DRIVE_LABELS_BASE_URL}/labels/${encodeURIComponent(labelId)}?view=LABEL_VIEW_FULL&useAdminAccess=false`,
  );
}

export async function applyDriveLabel(input: {
  accessToken: string;
  fetchImpl?: FetchLike;
  fieldModifications: FieldModification[];
  fileId: string;
  labelId: string;
}): Promise<void> {
  await driveJson<unknown>(
    input.fetchImpl ?? fetch,
    input.accessToken,
    "Applying the Drive label",
    `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(input.fileId)}/modifyLabels`,
    {
      body: JSON.stringify({
        kind: "drive#modifyLabelsRequest",
        labelModifications: [
          {
            fieldModifications: input.fieldModifications,
            labelId: input.labelId,
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
}
