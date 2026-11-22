import Link from "next/link";
import { formatMoney } from "@/lib/dashboard/format";

/** The frame around every public booking page. Quiet, so it sits well inside someone else's site. */
export function BookingShell({
  workspaceName,
  href,
  embed,
  children,
}: {
  workspaceName: string;
  href?: string;
  embed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:py-12">
      {!embed && (
        <p className="text-muted-foreground text-sm font-medium">
          {href ? (
            <Link href={href} className="hover:underline">
              {workspaceName}
            </Link>
          ) : (
            workspaceName
          )}
        </p>
      )}
      {children}
      <p className="text-muted-foreground pt-4 text-xs">Bookings by Maker Business Suite</p>
    </main>
  );
}

export const priceLabel = (cents: number, currency: string) =>
  cents === 0 ? "Free" : formatMoney(cents / 100, currency);

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : hours === 1 ? "1 hour" : `${hours} hours`;
}

export const NOTICES: Record<string, string> = {
  full: "Sorry, those places were just taken. Pick another time, or fewer places.",
  taken: "Sorry, that time was just taken. Pick another one.",
  gone: "That time is no longer available. Pick another one.",
  payments_off: "Online payment isn't set up for this yet. Please get in touch to book.",
  failed: "Something went wrong on our side and you haven't been charged. Please try again.",
  details: "Please fill in your name and a valid email address.",
  cancelled:
    "No payment was taken. Your places are held for a little while if you'd like to try again.",
  waitlisted: "You're on the waitlist. We'll email you if a place opens up.",
};
