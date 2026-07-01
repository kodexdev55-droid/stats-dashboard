import { Suspense } from 'react'
import { Dashboard } from './dashboard'

// This route is always dynamic — it depends on ?client= at runtime.
export const dynamic = 'force-dynamic'

export default function DashPage() {
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  )
}
