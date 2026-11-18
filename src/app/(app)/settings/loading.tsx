// While a Settings page loads, its card is drawn in outline beside the
// Settings menu, which stays as it is.
export default function SettingsLoading() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading settings"
      className="panel space-y-8 p-6 sm:p-8"
    >
      <div className="flex items-start gap-4">
        <div className="size-14 shrink-0 animate-pulse rounded-2xl bg-(--surface)" />
        <div className="w-full space-y-3">
          <div className="h-7 w-56 animate-pulse rounded-full bg-[#eeeff4]" />
          <div className="h-4 w-full max-w-lg animate-pulse rounded-full bg-[#eeeff4]" />
        </div>
      </div>
      <div className="space-y-3 border-t border-(--border) pt-8">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            className="h-20 animate-pulse rounded-2xl bg-(--surface)"
            key={index}
          />
        ))}
      </div>
    </section>
  );
}
