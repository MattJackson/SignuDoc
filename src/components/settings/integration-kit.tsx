"use client";

import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  HardDriveIcon,
  LockIcon,
  MailIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";

// The parts every integration in Settings is built from, so they all look
// and read the same: a header with the service's mark, its name, one line
// about it and where it stands; numbered steps; values to copy into the
// other service's console; test results; and the notice for settings fixed
// by the environment.

/**
 * The marks of the services SignuDoc connects to, kept in public/brands/
 * (see THIRD_PARTY_NOTICES.md). They are shown at their own proportions on
 * a white tile, never recolored or stretched, and only to name the service.
 */
export const BRAND_MARKS = {
  gmail: { label: "Gmail", src: "/brands/gmail.svg" },
  google: { label: "Google", src: "/brands/google-g.svg" },
  "google-cloud": { label: "Google Cloud", src: "/brands/google-cloud.svg" },
  "google-drive": { label: "Google Drive", src: "/brands/google-drive.svg" },
  resend: { label: "Resend", src: "/brands/resend.svg" },
  slack: { label: "Slack", src: "/brands/slack.svg" },
  vercel: { label: "Vercel", src: "/brands/vercel.svg" },
} as const;

export type BrandId = keyof typeof BRAND_MARKS | "local-disk" | "smtp";

// Things with no brand of their own, drawn as an icon on the same tile.
const ICON_MARKS: Partial<Record<BrandId, LucideIcon>> = {
  "local-disk": HardDriveIcon,
  smtp: MailIcon,
};

const MARK_SIZES = {
  lg: "size-14 rounded-2xl p-3",
  md: "size-12 rounded-2xl p-2.5",
  sm: "size-9 rounded-xl p-2",
} as const;

/** A service's mark on a white tile, or an icon when it has none. */
export function BrandMark({
  brand,
  icon,
  size = "md",
}: {
  brand?: BrandId | null;
  icon?: LucideIcon;
  size?: keyof typeof MARK_SIZES;
}) {
  const image =
    brand && brand in BRAND_MARKS
      ? BRAND_MARKS[brand as keyof typeof BRAND_MARKS]
      : null;
  const Icon = icon ?? (brand ? ICON_MARKS[brand] : undefined);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-(--border) bg-white",
        MARK_SIZES[size],
      )}
    >
      {image ? (
        // A local SVG at its own proportions: next/image adds nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className="h-full w-full object-contain"
          draggable={false}
          src={image.src}
        />
      ) : Icon ? (
        <Icon className="size-full text-(--secondary)" strokeWidth={1.75} />
      ) : null}
    </span>
  );
}

export type ConnectionStatus = "connected" | "needs_attention" | "not_set_up";

const STATUS_STYLES: Record<
  ConnectionStatus,
  { className: string; dot: string; label: string }
> = {
  connected: {
    className: "pill-success",
    dot: "bg-(--success)",
    label: "Connected",
  },
  needs_attention: {
    className: "pill-warning",
    dot: "bg-(--warning)",
    label: "Needs attention",
  },
  not_set_up: {
    className: "pill-neutral",
    dot: "bg-(--tertiary)",
    label: "Not set up",
  },
};

/** Connected, Needs attention or Not set up. The color says it; so does the text. */
export function StatusBadge({
  label,
  status,
}: {
  /** Replaces the standard wording, for a service with its own terms. */
  label?: string;
  status: ConnectionStatus;
}) {
  const style = STATUS_STYLES[status];

  return (
    <span className={cn("pill", style.className)} data-status={status}>
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", style.dot)}
      />
      {label ?? style.label}
    </span>
  );
}

type HeaderProps = {
  /** Buttons on the right: the main thing to do next. */
  actions?: ReactNode;
  brand?: BrandId | null;
  description: ReactNode;
  /** Where it stands now, in one line under the description. */
  detail?: ReactNode;
  icon?: LucideIcon;
  name: string;
  status?: ConnectionStatus | null;
  statusLabel?: string;
};

/** An integration's name, mark, one line about it and its status. */
export function IntegrationHeader({
  actions,
  brand,
  description,
  detail,
  icon,
  name,
  status,
  statusLabel,
}: HeaderProps) {
  return (
    <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <BrandMark brand={brand} icon={icon} size="lg" />
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
              {name}
            </h2>
            {status ? (
              <StatusBadge label={statusLabel} status={status} />
            ) : null}
          </div>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            {description}
          </p>
          {detail ? (
            <p className="max-w-2xl text-[0.8125rem] leading-5 text-(--tertiary)">
              {detail}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/** One integration's card in Settings: header, then its steps. */
export function IntegrationPanel({
  children,
  id,
  ...header
}: HeaderProps & { children: ReactNode; id?: string }) {
  return (
    <section
      className="panel scroll-mt-6 space-y-8 p-6 sm:p-8"
      data-animate="enter"
      id={id}
    >
      <IntegrationHeader {...header} />
      <div className="space-y-6 border-t border-(--border) pt-8">
        {children}
      </div>
    </section>
  );
}

/** A heading inside a panel, with an optional badge beside it. */
export function SubsectionHeading({
  badge,
  children,
  description,
  id,
}: {
  badge?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  id?: string;
}) {
  return (
    <div className="space-y-2" id={id}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          {children}
        </h3>
        {badge}
      </div>
      {description ? (
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** An integration on the Integrations overview. */
export function IntegrationCard({
  brand,
  description,
  detail,
  href,
  icon,
  name,
  status,
}: {
  brand?: BrandId | null;
  description: string;
  detail?: string;
  href: string;
  icon?: LucideIcon;
  name: string;
  status: ConnectionStatus;
}) {
  return (
    <Link
      className="panel group flex h-full flex-col gap-4 p-5 ring-1 ring-(--border) transition hover:ring-(--border-strong) hover:shadow-(--shadow-card) focus-visible:ring-2 focus-visible:ring-(--accent)"
      data-integration={href.split("/").pop()}
      href={href}
    >
      <div className="flex items-start justify-between gap-3">
        <BrandMark brand={brand} icon={icon} />
        <StatusBadge status={status} />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-extrabold tracking-[-0.01em] text-(--fg)">
          {name}
        </h3>
        <p className="text-sm leading-6 text-(--secondary)">{description}</p>
      </div>
      {detail ? (
        <p className="text-[0.8125rem] leading-5 text-(--tertiary)">{detail}</p>
      ) : null}
      <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-bold text-(--accent-ink)">
        {status === "connected" ? "Manage" : "Set up"}
        <ArrowRightIcon
          aria-hidden="true"
          className="size-4 transition group-hover:translate-x-0.5"
        />
      </span>
    </Link>
  );
}

/** A numbered list of steps. Put SetupStep items in it. */
export function SetupSteps({ children }: { children: ReactNode }) {
  return <ol className="space-y-3">{children}</ol>;
}

/**
 * One step: a number (a tick once it is done), a title, whether it is done,
 * and what to do. A title written "2. Do this" gets its number from the
 * text.
 */
export function SetupStep({
  children,
  number,
  ok,
  optional = false,
  title,
}: {
  children: ReactNode;
  number?: number;
  /** Done, still to do, or neither (nothing to check). */
  ok: boolean | null;
  optional?: boolean;
  title: string;
}) {
  const parsed = /^(\d+)\.\s+(.*)$/.exec(title);
  const position = number ?? (parsed ? Number(parsed[1]) : null);
  const text = parsed ? parsed[2] : title;

  return (
    <li className="flex gap-4 rounded-2xl bg-(--surface) px-5 py-4">
      {position !== null ? (
        <span
          aria-hidden="true"
          className={cn(
            "mt-px inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
            ok
              ? "bg-(--success-soft) text-(--success)"
              : "bg-(--paper) text-(--secondary) ring-1 ring-(--border-strong)",
          )}
        >
          {ok ? <CheckIcon className="size-3.5" /> : position}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h4 className="text-sm font-bold text-(--fg)">
            {position !== null ? (
              <span className="sr-only">Step {position}: </span>
            ) : null}
            {text}
          </h4>
          {ok === null ? (
            optional ? (
              <span className="pill pill-neutral">Optional</span>
            ) : null
          ) : (
            <span className={cn("pill", ok ? "pill-success" : "pill-neutral")}>
              {ok ? "Done" : "To do"}
            </span>
          )}
        </div>
        <div className="space-y-3 text-sm leading-6 text-(--secondary)">
          {children}
        </div>
      </div>
    </li>
  );
}

export const CheckItem = SetupStep;

function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  function copy() {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);

        if (timer.current) {
          clearTimeout(timer.current);
        }

        timer.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  }

  return { copied, copy };
}

/** A Copy button for one value. */
export function CopyButton({
  label,
  value,
}: {
  /** What is copied, for screen readers: "Copy redirect URI". */
  label?: string;
  value: string;
}) {
  const { copied, copy } = useCopy(value);

  return (
    <button
      aria-label={label ? `Copy ${label}` : undefined}
      className="btn-quiet shrink-0"
      onClick={copy}
      type="button"
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3.5 text-(--success)" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3.5" />
      )}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/**
 * A value an administrator pastes somewhere else, with its name above it
 * and a Copy button beside it.
 */
export function CopyValue({
  hint,
  label,
  value,
}: {
  hint?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[0.8125rem] font-semibold text-(--secondary)">
        {label}
      </span>
      <div className="flex items-start gap-2">
        <code
          aria-label={label}
          className="min-h-10 min-w-0 flex-1 rounded-xl border-[1.5px] border-(--border-strong) bg-(--paper) px-3.5 py-2 font-mono text-[0.8125rem] leading-6 break-all text-(--fg)"
        >
          {value}
        </code>
        <CopyButton label={label} value={value} />
      </div>
      {hint ? (
        <span className="block text-xs leading-5 text-(--tertiary)">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export const linkClassName =
  "font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4 hover:decoration-(--accent-ink)";

/** A link to another site, in a new tab. */
export function ExternalLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a className={linkClassName} href={href} rel="noreferrer" target="_blank">
      {children}
      <ExternalLinkIcon
        aria-hidden="true"
        className="ml-0.5 inline size-3.5 -translate-y-px"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** A button that opens another site's console in a new tab. */
export function ExternalButton({
  children,
  href,
  variant = "secondary",
}: {
  children: ReactNode;
  href: string;
  variant?: "primary" | "secondary";
}) {
  return (
    <a
      className={cn(
        buttonVariants({
          variant: variant === "primary" ? "default" : "outline",
        }),
        "min-h-12 w-fit px-5.5 text-[0.9375rem]",
      )}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLinkIcon aria-hidden="true" className="size-4" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export type NoticeTone = "error" | "info" | "success" | "warning";

const NOTICE_CLASSES: Record<NoticeTone, string> = {
  error: "notice-danger",
  info: "notice-accent",
  success: "notice-success",
  warning: "notice-warning",
};

/** A message in a tinted box. Errors are announced at once. */
export function Notice({
  children,
  tone,
}: {
  children: ReactNode;
  tone: NoticeTone;
}) {
  const Icon =
    tone === "success"
      ? CheckCircle2Icon
      : tone === "error" || tone === "warning"
        ? AlertCircleIcon
        : null;

  return (
    <div
      className={cn("notice flex items-start gap-2.5", NOTICE_CLASSES[tone])}
      role={tone === "error" ? "alert" : "status"}
    >
      {Icon ? (
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      ) : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The result of a Test button: worked, or what went wrong. */
export function TestResult({
  result,
}: {
  result: { message: ReactNode; ok: boolean } | null;
}) {
  if (!result) {
    return null;
  }

  return (
    <Notice tone={result.ok ? "success" : "error"}>{result.message}</Notice>
  );
}

/**
 * Settings fixed by environment variables where the site runs: shown, but
 * changed there, not here.
 */
export function EnvLockedNotice({
  children,
  variables,
}: {
  children?: ReactNode;
  variables: string[];
}) {
  const names = variables.map((name, index) => (
    <span key={name}>
      {index > 0 ? (index === variables.length - 1 ? " and " : ", ") : null}
      <code className="font-mono text-[0.8125rem] text-(--fg)">{name}</code>
    </span>
  ));

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-(--border) bg-(--paper) px-5 py-4 text-sm leading-6 text-(--secondary)">
      <LockIcon
        aria-hidden="true"
        className="mt-1 size-4 shrink-0 text-(--tertiary)"
      />
      <div className="space-y-1">
        <p>
          <span className="font-bold text-(--fg)">Set by the environment.</span>{" "}
          The {names}{" "}
          {variables.length === 1 ? "variable sets" : "variables set"} this
          where the site runs, so it is changed there.
        </p>
        {children}
      </div>
    </div>
  );
}

/** A row of buttons under a form or a step. */
export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * Points at the automatic Google Workspace setup, which does the Google
 * steps of several panels at once and can be run again at any time.
 */
export function AutomaticGoogleSetupNotice() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-(--accent-softer) px-5 py-4 text-sm leading-6 text-(--secondary) sm:flex-row sm:items-center sm:justify-between">
      <p>
        <span className="font-bold text-(--fg)">
          Rather not click through Google?
        </span>{" "}
        The automatic setup does these steps with one super admin sign-in, and
        can be run again to fix anything.
      </p>
      <Link
        className={cn(
          buttonVariants({ variant: "outline" }),
          "min-h-10 w-fit shrink-0 px-4 text-sm",
        )}
        href="/settings/google-setup"
      >
        Run automatic setup
      </Link>
    </div>
  );
}
