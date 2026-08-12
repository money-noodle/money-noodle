import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const sans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.MONEY_NOODLE_BASE_URL ?? 'http://localhost:3000'),
  applicationName: 'Money Noodle',
  title: 'Money Noodle · Crypto prediction research',
  description: 'A local, evidence-first crypto prediction research and trading terminal.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/brand/money-noodle-icon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/brand/money-noodle-icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: '/apple-icon.png', type: 'image/png', sizes: '180x180' }],
  },
  openGraph: {
    title: 'Money Noodle',
    description: 'Evidence-first crypto prediction research and automated trading.',
    siteName: 'Money Noodle',
    images: [{ url: '/brand/money-noodle-social.png', width: 1200, height: 630, alt: 'Money Noodle' }],
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#f6f8f3',
  colorScheme: 'light dark',
};

const themeBootstrap = `(() => {
  try {
    const saved = localStorage.getItem('money-noodle-theme');
    const dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.classList.toggle('light', !dark && saved === 'light');
  } catch { /* CSS still follows the system preference when browser storage is unavailable. */ }
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }}/></head>
      <body className={`${sans.variable} ${mono.variable} antialiased`}>{children}</body>
    </html>
  );
}
