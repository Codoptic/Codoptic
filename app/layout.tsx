import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Codoptic: diagram-as-code',
  description: 'Open-source local diagram-as-code editor and agentic repo explorer.',
  // Motivation vs Logic: reuse the brand mark so the tab favicon matches the header logo.
  // Root Cause vs Logic: hashed runtime assets never registered as the browser favicon, so point metadata to the static `/logo.png`.
  icons: {
    icon: '/logo.png',
    shortcut: '/logo.png',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink-950 text-ink-100">{children}</body>
    </html>
  );
}
