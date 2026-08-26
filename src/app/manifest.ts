import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Money Noodle',
    short_name: 'Money Noodle',
    description: 'A local, evidence-first crypto prediction research and trading terminal.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f6f8f3',
    theme_color: '#35a94b',
    icons: [
      { src: '/brand/money-noodle-icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/money-noodle-icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
