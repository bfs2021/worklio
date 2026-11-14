import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Geist_Mono, IBM_Plex_Sans, Inter, Lato, Nunito_Sans } from "next/font/google";

import { AppearanceProvider, AppearanceScript } from "@/components/appearance-provider";

import "./globals.css";

// Inter is the default and preloaded; the rest load only when chosen in Preferences.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const lato = Lato({ variable: "--font-lato", subsets: ["latin"], weight: ["400", "700", "900"], preload: false });
const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600", "700"], preload: false });
const nunito = Nunito_Sans({ variable: "--font-nunito", subsets: ["latin"], preload: false });
const atkinson = Atkinson_Hyperlegible({ variable: "--font-atkinson", subsets: ["latin"], weight: ["400", "700"], preload: false });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Worklio",
  description: "Team messaging",
};

// viewport-fit=cover enables env(safe-area-inset-*) on notched phones; resizes-content makes
// Android shrink h-dvh when the on-screen keyboard opens, so the composer stays visible.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const fonts = [inter, lato, plex, nunito, atkinson, geistMono].map((f) => f.variable).join(" ");
  return (
    <html lang="en" className={`${fonts} h-full antialiased`} suppressHydrationWarning>
      <head>
        <AppearanceScript />
      </head>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <AppearanceProvider>{children}</AppearanceProvider>
      </body>
    </html>
  );
}
