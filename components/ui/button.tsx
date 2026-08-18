import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none border text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171817] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f5f5ef] disabled:pointer-events-none disabled:opacity-50",
  { variants: { variant: { default: "border-[#171817] bg-[#171817] text-[#f5f5ef] hover:bg-[#d8ff42] hover:text-[#171817] dark:!border-[#d8ff42] dark:!bg-[#d8ff42] dark:!text-[#080a0c] dark:hover:!bg-[#c9e83c]", outline: "border-[#171817] bg-transparent text-[#171817] hover:bg-[#d8ff42] dark:border-[#252a30] dark:bg-[#111417] dark:text-[#f5f7fa] dark:hover:border-[#d8ff42] dark:hover:bg-[#161a1e]", ghost: "border-transparent text-[#5f625d] hover:border-[#d5d6ce] hover:bg-[#ecece5] hover:text-[#171817] dark:text-[#9ca3af] dark:hover:border-[#252a30] dark:hover:bg-[#161a1e] dark:hover:text-[#f5f7fa]" }, size: { default: "h-11 px-5", sm: "h-9 px-3", lg: "h-12 px-6 text-base" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => { const Comp = asChild ? Slot : "button"; return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />; });
Button.displayName = "Button";
export { Button, buttonVariants };
