import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// One filled ochre button per screen: the thing to do next. Everything else
// is outlined, dark teal or ghost.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-sm text-sm font-semibold whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-ochre text-primary-foreground hover:bg-ochre-hover",
        outline: "border border-input bg-card text-foreground hover:bg-hover",
        dark: "bg-teal text-on-teal hover:bg-teal-2",
        secondary: "bg-secondary text-secondary-foreground hover:bg-sunken",
        ghost: "text-text-2 hover:bg-hover",
        danger: "text-brick hover:bg-brick-soft",
        link: "text-ochre-text underline-offset-2 hover:text-brick hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-[30px] px-2.5 text-xs",
        lg: "h-10 px-5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
