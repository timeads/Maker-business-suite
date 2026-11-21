import * as React from "react";
import { cn } from "@/lib/utils";

const fieldClasses =
  "h-10 w-full rounded-md border border-input bg-card px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(fieldClasses, className)} {...props} />;
}

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(fieldClasses, "pr-8", className)} {...props} />;
}

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-sm leading-none font-medium", className)} {...props} />;
}

export { Input, Label, Select };
