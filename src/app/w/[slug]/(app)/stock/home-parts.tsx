"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import { syncNow, type ConnectionState } from "../connections/actions";
import { checkAllShipments, checkShipmentNow, updateShipment } from "./actions";

const small = "max-w-56 text-right text-xs";

/** "Read my shop now": queues a read of the shop rather than waiting for the hourly one. */
export function SyncShopButton({ slug }: { slug: string }) {
  const [state, action] = useActionState<ConnectionState, FormData>(
    syncNow.bind(null, slug, "shopify"),
    {},
  );
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <SubmitButton variant="outline" size="sm" pendingText="Starting…">
        Read my shop now
      </SubmitButton>
      {state.error && (
        <span role="alert" className={`text-brick ${small}`}>
          {state.error}
        </span>
      )}
      {state.message && (
        <span className={`text-muted-foreground ${small}`}>
          {state.message.replace("This page updates when it finishes.", "Give it a few minutes.")}
        </span>
      )}
    </form>
  );
}

/** "Ask UPS about all of them", above the parcels. */
export function CheckAllButton({ slug }: { slug: string }) {
  const [state, action] = useActionState(checkAllShipments.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <SubmitButton variant="outline" size="sm" pendingText="Asking…">
        Ask UPS about all of them
      </SubmitButton>
      {state.error && (
        <span role="alert" className={`text-brick ${small}`}>
          {state.error}
        </span>
      )}
      {state.message && <span className={`text-muted-foreground ${small}`}>{state.message}</span>}
    </form>
  );
}

/** "It's here" (and "Check now" for a UPS parcel) on one parcel's card. */
export function ParcelButtons({
  slug,
  orderId,
  shipmentId,
  canCheck,
}: {
  slug: string;
  orderId: string;
  shipmentId: string;
  canCheck: boolean;
}) {
  const [here, hereAction] = useActionState(
    updateShipment.bind(null, slug, orderId, shipmentId, "arrived"),
    {},
  );
  const [check, checkAction] = useActionState(checkShipmentNow.bind(null, slug, shipmentId), {});
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {canCheck && (
          <form action={checkAction}>
            <SubmitButton variant="ghost" size="sm" pendingText="Asking…">
              Check now
            </SubmitButton>
          </form>
        )}
        <form action={hereAction}>
          <SubmitButton variant="outline" size="sm" pendingText="Saving…">
            It&apos;s here
          </SubmitButton>
        </form>
      </div>
      {(here.error || check.error) && (
        <span role="alert" className={`text-brick ${small}`}>
          {here.error ?? check.error}
        </span>
      )}
      {check.message && <span className={`text-muted-foreground ${small}`}>{check.message}</span>}
    </div>
  );
}
