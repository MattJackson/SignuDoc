"use client";

import { Roboto } from "next/font/google";

import { cn } from "@/lib/cn";

// "Continue with Google", drawn the way Google's sign-in branding
// guidelines ask (developers.google.com/identity/branding-guidelines):
// the standard "G" unchanged at 20px on a white button with a 1px #747775
// border, 12px padding at the sides and 10px between the G and the text,
// which is Roboto Medium 14/20 in #1F1F1F, 40px high, in the pill shape.
// Only Google's approved wording is used. The G is Google's own asset
// (public/brands/google-g.svg; see THIRD_PARTY_NOTICES.md).

const roboto = Roboto({
  display: "swap",
  subsets: ["latin"],
  weight: "500",
});

const APPROVED_LABELS = new Set([
  "Continue with Google",
  "Sign in with Google",
  "Sign up with Google",
]);

export function GoogleSignInButton({
  busy = false,
  label = "Continue with Google",
  onClick,
}: {
  busy?: boolean;
  label?: string;
  onClick: () => void;
}) {
  const text = APPROVED_LABELS.has(label) ? label : "Continue with Google";

  return (
    <button
      aria-busy={busy || undefined}
      className={cn(
        roboto.className,
        "relative inline-flex h-10 w-full items-center justify-center gap-2.5 rounded-full border border-[#747775] bg-white px-3 text-sm leading-5 font-medium tracking-[0.25px] text-[#1f1f1f] transition-colors outline-none",
        "hover:bg-[#f7f8f8] focus-visible:ring-3 focus-visible:ring-[rgb(var(--accent-rgb)/0.32)] active:bg-[#eef0f1]",
        "disabled:cursor-not-allowed disabled:border-[#1f1f1f1f] disabled:bg-[#ffffff61] disabled:text-[#1f1f1f61]",
      )}
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        className={cn("size-5 shrink-0", busy ? "opacity-40" : "")}
        draggable={false}
        height={20}
        src="/brands/google-g.svg"
        width={20}
      />
      <span>{text}</span>
    </button>
  );
}
