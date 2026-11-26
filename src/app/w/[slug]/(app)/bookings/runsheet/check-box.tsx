"use client";

import { useState, useTransition } from "react";
import { setAttendance } from "../roster-actions";

/**
 * The runsheet's "In" box: ticking it checks the person in, unticking takes
 * it back. Open to the whole team, like check-in on the roster. A no-show
 * mark shows as unticked; ticking it changes it to here.
 */
export function CheckInBox({
  slug,
  bookingId,
  name,
  attendance,
  disabled,
}: {
  slug: string;
  bookingId: string;
  name: string;
  attendance: "attended" | "no_show" | null;
  disabled?: boolean;
}) {
  const [here, setHere] = useState(attendance === "attended");
  const [pending, start] = useTransition();
  return (
    <input
      type="checkbox"
      className="size-5 cursor-pointer align-middle disabled:cursor-default"
      checked={here}
      disabled={disabled || pending}
      aria-label={`${name} is here`}
      onChange={(event) => {
        const next = event.target.checked;
        setHere(next);
        start(async () => {
          const result = await setAttendance(slug, bookingId, next ? "attended" : null);
          if (result.error) setHere(!next);
        });
      }}
    />
  );
}
