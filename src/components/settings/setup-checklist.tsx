import Link from "next/link";

import type {
  OnboardingStepState,
  OnboardingStepStatus,
} from "@/lib/onboarding/steps";

// Settings: every onboarding step with where it stands, each one a link
// back into onboarding at that step.

const STATUS_LABELS: Record<OnboardingStepStatus, string> = {
  done: "Done",
  needs_attention: "Needs attention",
  not_started: "Not set up",
  skipped: "Skipped",
};

const STATUS_PILLS: Record<OnboardingStepStatus, string> = {
  done: "pill-success",
  needs_attention: "pill-warning",
  not_started: "pill-neutral",
  skipped: "pill-neutral",
};

export function SetupChecklist({ steps }: { steps: OnboardingStepState[] }) {
  const done = steps.filter((step) => step.status === "done").length;

  return (
    <section
      className="panel scroll-mt-6 space-y-5 p-6 sm:p-8"
      data-animate="enter"
      id="setup-checklist"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Setup checklist
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            {done === steps.length
              ? "Everything is set up. Any step can be opened again to change it."
              : `${String(done)} of ${String(steps.length)} steps done. Open a step to finish it, or come back to it later.`}
          </p>
        </div>
        <Link className="btn-quiet" href="/onboarding">
          Open onboarding
        </Link>
      </div>
      <ol className="divide-y divide-(--border) rounded-2xl border border-(--border)">
        {steps.map((step, index) => (
          <li key={step.id}>
            <Link
              className="flex flex-col gap-1 px-5 py-4 transition hover:bg-(--surface) sm:flex-row sm:items-center sm:justify-between"
              data-step={step.id}
              href={`/onboarding?step=${step.id}`}
            >
              <span className="space-y-0.5">
                <span className="block text-sm font-bold text-(--fg)">
                  {index + 1}. {step.title}
                </span>
                <span className="block text-sm leading-6 text-(--secondary)">
                  {step.detail}
                </span>
              </span>
              <span className={`pill w-fit ${STATUS_PILLS[step.status]}`}>
                {STATUS_LABELS[step.status]}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
