import type { Metadata, Viewport } from 'next';
import '@/ui/tokens.css';
import { ToastProvider } from '@/components/toast';

export const metadata: Metadata = {
  title: 'PostPilot · LinkedIn automation',
  description:
    'Personal LinkedIn content automation: plan in Sheets, approve on WhatsApp or email, publish via API.',
  robots: { index: false, follow: false },
  // Phase 10: installable. Without these the browser offers "add to home screen" only in a tab.
  manifest: '/manifest.webmanifest',
  applicationName: 'PostPilot',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'PostPilot' },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f4ef' },
    { media: '(prefers-color-scheme: dark)', color: '#12100e' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
