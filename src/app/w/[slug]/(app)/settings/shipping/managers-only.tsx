import { Card, CardContent } from "@/components/ui/card";

/** What the rest of the team sees where only an owner or admin can change Shipping's settings. */
export function ShippingManagersOnly() {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-muted-foreground text-sm">
          An owner or admin can change these settings.
        </p>
      </CardContent>
    </Card>
  );
}
