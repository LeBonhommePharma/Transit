import type { Metadata } from "next";
import { IBM_Plex_Mono, Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  display: "swap",
});

const plex = IBM_Plex_Mono({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Rive, atlas RTC, STLévis, STM et STL",
  description:
    "Carte, trajectoires et horaires officiels à Québec, Lévis, Montréal et Laval. Gratuit, sans abonnement.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="fr"
      className={`${outfit.variable} ${outfit.className} ${plex.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-[#f5f5f7] font-sans text-[#1d1d1f]">{children}</body>
    </html>
  );
}
