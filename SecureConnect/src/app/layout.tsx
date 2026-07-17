import "./globals.css";
import type { Metadata } from "next";
import { ThemeProvider } from "@/context/ThemeContext";

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME || "DatabaseManager",
  description: "Secure DB manager (FE + embedded API)",
  robots: { index: false, follow: false, nocache: true }
};

// Runs before hydration to set data-theme from localStorage (or OS preference),
// preventing a flash of the wrong theme and keeping SSR/CSR markup consistent.
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
