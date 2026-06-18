import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Archive",
  description: "Portfolio archive",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, backgroundColor: "#ffffff" }}>
        {children}
      </body>
    </html>
  );
}
