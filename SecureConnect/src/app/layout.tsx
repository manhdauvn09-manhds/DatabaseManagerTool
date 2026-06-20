import "./globals.css";
import type { Metadata } from "next";
import { ThemeProvider } from "@/context/ThemeContext";

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME || "DatabaseManager",
  description: "Secure DB manager (FE + embedded API)",
  robots: { index: false, follow: false, nocache: true }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
