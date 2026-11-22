'use client'
import { useState } from 'react'

// Rendered on the client only (see `clientOnly` in the test config).
export function ClientCounter({ start }: { start: number }) {
  const [n, setN] = useState(start)
  return (
    <button id="client-counter" onClick={() => setN((c) => c + 1)}>
      Client: {n}
    </button>
  )
}
