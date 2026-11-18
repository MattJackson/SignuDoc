import { ShellButton } from "@/components/shared/form-shell";

// The way from Settings to Settings, Notifications, which has a page of its
// own: everyone's direct message choices, and for an administrator the
// channels and rules.
export function NotificationsLinkPanel({ isAdmin }: { isAdmin: boolean }) {
  return (
    <section
      className="panel scroll-mt-6 space-y-3 p-6 sm:p-8"
      data-animate="enter"
      id="notifications"
    >
      <p className="section-eyebrow">Notifications</p>
      <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
        Notifications
      </h2>
      <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
        {isAdmin
          ? "Send messages to Slack when envelopes are signed, completed, declined or stuck, choose which channels hear about which team's envelopes, and choose what you hear about yourself."
          : "Choose what you get a direct message about when your envelopes, or your teammates', are signed, completed, declined or stuck."}
      </p>
      <ShellButton href="/settings/notifications" variant="secondary">
        Open notification settings
      </ShellButton>
    </section>
  );
}
