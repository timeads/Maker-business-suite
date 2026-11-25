"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { shippingAnchorPath } from "@/lib/settings/redirects";

/**
 * Shipping's settings used to be one page with anchors (`#printing`, `#slip`,
 * `#rules`, `#memory`). Old links land on the first Shipping screen with the
 * anchor still on the address; this sends them on to the screen that card
 * moved to. It shows nothing.
 */
export function ShippingAnchorForward({ slug }: { slug: string }) {
  const router = useRouter();
  useEffect(() => {
    const target = shippingAnchorPath(slug, window.location.hash);
    if (target) router.replace(target);
  }, [router, slug]);
  return null;
}
