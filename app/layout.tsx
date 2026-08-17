import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  applicationName: "Sentinel",
  title: {
    default: "Sentinel — AI-powered dependency intelligence for GitHub repositories",
    template: "%s | Sentinel",
  },
  description:
    "Sentinel brings dependency intelligence, repository monitoring, upgrade risk analysis, and a human-controlled maintenance workflow to GitHub repositories.",
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Sentinel",
    title: "Sentinel — AI-powered dependency intelligence for GitHub repositories",
    description:
      "Analyze dependency updates, monitor repository maintenance health, assess upgrade risk, and prepare validated GitHub Draft PRs for human review.",
  },
  twitter: {
    card: "summary",
    title: "Sentinel — AI-powered dependency intelligence for GitHub repositories",
    description:
      "Analyze dependency updates, monitor repository maintenance health, assess upgrade risk, and keep maintenance decisions under human control.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}><body>{children}</body></html>;
}
