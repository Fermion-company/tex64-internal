import type { Metadata, Viewport } from "next";
import { Noto_Serif_JP } from "next/font/google";
import type { ReactNode } from "react";
import "katex/dist/katex.min.css";
import "./globals.css";

const paperSerif = Noto_Serif_JP({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-noto-serif",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "TeX64",
  description: "考えを伝えるだけで、文書を構成から仕上げまで整えます。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#110A1C" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ja" data-theme="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            // 配色は OS 設定に追従（アプリ内トグルは持たない）。
            __html:
              '(function(){try{var m=window.matchMedia("(prefers-color-scheme: light)");var a=function(){document.documentElement.setAttribute("data-theme",m.matches?"light":"dark")};a();m.addEventListener("change",a)}catch(e){}try{if(window.tex64Native)document.documentElement.setAttribute("data-platform","native")}catch(e){}})()',
          }}
        />
      </head>
      <body className={paperSerif.variable}>{children}</body>
    </html>
  );
}
