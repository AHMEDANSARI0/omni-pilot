import type { Metadata, Viewport } from 'next';
import '@/ui/tokens.css';
import { ToastProvider } from '@/components/toast';

export const metadata: Metadata = {
  title: 'PostPilot · LinkedIn automation',
  description:
    'Personal LinkedIn content automation: plan in Sheets, approve on WhatsApp or email, publish via API.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#f7f4ef',
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
