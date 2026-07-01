import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Deligatr | LinkedIn Outreach Report',
  description: 'LinkedIn outreach performance dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
