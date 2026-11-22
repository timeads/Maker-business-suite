import { cn } from "@/lib/utils";

export function FormMessage({
  kind = "error",
  children,
}: {
  kind?: "error" | "success";
  children: React.ReactNode;
}) {
  if (!children) return null;
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        kind === "error"
          ? "border-brick/25 bg-brick-soft text-brick"
          : "border-mint-ink/15 bg-mint-soft text-mint-ink",
      )}
    >
      {children}
    </p>
  );
}
