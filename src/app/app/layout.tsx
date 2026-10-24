import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Outfit } from "next/font/google";

import { CartProvider } from "@/components/app/cart";
import { Shell } from "@/components/app/Shell";
import "./app.css";

const outfit = Outfit({ subsets: ["latin"], weight: ["600", "800"], variable: "--font-outfit" });
const instrument = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-instrument" });

export const metadata: Metadata = {
  title: "Mándalo",
  description: "Tu mandado a domicilio",
  applicationName: "Mándalo",
  manifest: "/app/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Mándalo", statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#E00B2D",
  width: "device-width",
  initialScale: 1,
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`mandalo ${outfit.variable} ${instrument.variable}`}>
      <CartProvider>
        <Shell>{children}</Shell>
      </CartProvider>
    </div>
  );
}
