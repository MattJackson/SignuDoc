"use client";

import {
  BellIcon,
  Building2Icon,
  DatabaseBackupIcon,
  ListChecksIcon,
  PlugIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  StampIcon,
  UserCogIcon,
  UserRoundIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

// The list of Settings pages down the side, grouped the way an
// administrator thinks about them. Everyone sees their own account and
// notifications; the rest is the administrator's. On a narrow screen it
// becomes one row that scrolls sideways.

type NavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
};

type NavGroup = { items: NavItem[]; label: string };

export function SettingsNav({
  hosted,
  isAdmin,
}: {
  /** The hosted service has no organization-wide integrations. */
  hosted: boolean;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const groups: NavGroup[] = [
    {
      items: [
        {
          href: "/settings",
          icon: UserRoundIcon,
          label: "Profile and sign-in",
        },
        {
          href: "/settings/notifications",
          icon: BellIcon,
          label: "Notifications",
        },
      ],
      label: "Your account",
    },
  ];

  if (isAdmin) {
    groups.push(
      {
        items: [
          {
            href: "/settings/organization",
            icon: Building2Icon,
            label: "General",
          },
          ...(hosted
            ? []
            : [
                {
                  href: "/settings/setup",
                  icon: ListChecksIcon,
                  label: "Setup checklist",
                },
              ]),
        ],
        label: "Organization",
      },
      {
        items: [
          ...(hosted
            ? []
            : [
                {
                  href: "/settings/people",
                  icon: ShieldCheckIcon,
                  label: "People and security",
                },
              ]),
          { href: "/settings/teams", icon: UsersRoundIcon, label: "Teams" },
          ...(hosted
            ? []
            : [
                {
                  href: "/settings/managers",
                  icon: UserCogIcon,
                  label: "Managers and leavers",
                },
              ]),
        ],
        label: "Sign-in & people",
      },
      {
        items: [
          {
            href: "/settings/integrations",
            icon: PlugIcon,
            label: "Integrations",
          },
        ],
        label: "Integrations",
      },
      {
        items: [
          {
            href: "/settings/documents",
            icon: StampIcon,
            label: "Seal and records",
          },
        ],
        label: "Documents & seal",
      },
      {
        items: [
          {
            href: "/settings/backups",
            icon: DatabaseBackupIcon,
            label: "Backups",
          },
        ],
        label: "Data & backups",
      },
      {
        items: [
          {
            href: "/settings/updates",
            icon: RefreshCwIcon,
            label: "SignuDoc version",
          },
        ],
        label: "Updates",
      },
    );
  }

  const isActive = (item: NavItem) =>
    item.href === "/settings"
      ? pathname === "/settings"
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <nav
      aria-label="Settings"
      className="panel min-w-0 p-2 lg:sticky lg:top-6 lg:p-3"
      data-animate="enter"
    >
      <div className="flex gap-1 overflow-x-auto lg:block lg:space-y-4 lg:overflow-visible">
        {groups.map((group) => (
          <div className="contents lg:block" key={group.label}>
            <p className="section-eyebrow hidden px-3 pb-1.5 lg:block">
              {group.label}
            </p>
            <ul className="contents lg:block lg:space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item);
                const Icon = item.icon;

                return (
                  <li className="shrink-0" key={item.href}>
                    <Link
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-sm whitespace-nowrap transition",
                        active
                          ? "bg-(--accent-softer) font-bold text-(--accent-ink)"
                          : "font-semibold text-(--secondary) hover:bg-(--surface) hover:text-(--fg)",
                      )}
                      href={item.href}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          "size-4 shrink-0",
                          active ? "text-(--accent-ink)" : "text-(--tertiary)",
                        )}
                      />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
