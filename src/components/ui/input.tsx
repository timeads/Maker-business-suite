import * as React from "react";
import { cn } from "@/lib/utils";

const fieldClasses =
  "h-9 w-full rounded-sm border border-input bg-card px-[11px] text-sm outline-none transition-colors duration-150 placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-2 focus-visible:ring-ochre/25 disabled:cursor-not-allowed disabled:opacity-60";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(fieldClasses, className)} {...props} />;
}

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(fieldClasses, "pr-8", className)} {...props} />;
}

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-xs leading-tight font-semibold", className)} {...props} />;
}

export { Input, Label, Select };
