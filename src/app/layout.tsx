import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Maker Business Suite", template: "%s · Maker Business Suite" },
  description: "Money, customers, bookings and social for small maker businesses, in one place.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        {/* Every signed-in page reads the session, so pages stream in behind this boundary. */}
        <Suspense fallback={null}>{children}</Suspense>
      </body>
    </html>
  );
}
