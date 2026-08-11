import * as React from "react";
import { cn } from "@/lib/utils";
export function Card({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("rounded-none border border-[#d5d6ce] bg-[#f9f9f5] text-[#171817] shadow-none", className)} {...props} />; }
export function CardHeader({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("flex flex-col gap-1.5 p-6", className)} {...props} />; }
export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) { return <h2 className={cn("text-lg font-medium tracking-[-.03em]", className)} {...props} />; }
export function CardDescription({ className, ...props }: React.ComponentProps<"p">) { return <p className={cn("text-sm leading-6 text-[#696b66]", className)} {...props} />; }
export function CardContent({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("p-6 pt-0", className)} {...props} />; }
