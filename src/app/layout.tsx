import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Xiangqi Online — A table for two',
  description:
    'Chinese chess with a friend. Private rooms, thoughtful clocks, and a board that feels like home. No accounts needed.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
