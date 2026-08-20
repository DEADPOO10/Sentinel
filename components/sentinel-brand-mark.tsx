import type { HTMLAttributes } from "react";

type SentinelBrandMarkProps = HTMLAttributes<HTMLSpanElement>;

export function SentinelBrandMark({
  className,
  ...props
}: SentinelBrandMarkProps) {
  return (
    <span
      className={`grid h-full w-full place-items-center rounded-[0.2rem] bg-[#d8ff42] text-[#111417] ${className ?? ""}`}
      {...props}
    >
      <svg
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5.2"
        aria-hidden="true"
        className="h-[82%] w-[82%]"
      >
        <path d="M19 10h-1.6c-2.7 0-4.4 1.7-4.4 4.4v5.1c0 2.4-1.2 3.9-3.4 4.5 2.2.6 3.4 2.1 3.4 4.5v5.1c0 2.7 1.7 4.4 4.4 4.4H19" />
        <path d="M26 12 22 36" strokeWidth="3.2" />
        <path d="M29 10h1.6c2.7 0 4.4 1.7 4.4 4.4v5.1c0 2.4 1.2 3.9 3.4 4.5-2.2.6-3.4 2.1-3.4 4.5v5.1c0 2.7-1.7 4.4-4.4 4.4H29" />
      </svg>
    </span>
  );
}
