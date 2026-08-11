import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
const badgeVariants = cva("inline-flex items-center gap-1.5 rounded-none border px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-[.08em]", { variants: { variant: { default: "border-[#d5d6ce] bg-[#ecece5] text-[#5f625d]", success: "border-[#b9d9c8] bg-[#e7f3eb] text-[#237a53]", warning: "border-[#e4c99f] bg-[#f8efdf] text-[#8b4d10]", danger: "border-[#e0b8b1] bg-[#f9e9e6] text-[#93342a]", info: "border-[#cbd0c6] bg-[#ecece5] text-[#343633]" } }, defaultVariants: { variant: "default" } });
export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) { return <span className={cn(badgeVariants({ variant }), className)} {...props} />; }
