'use client'
import { useState } from 'react'

// A classic island: local state + event handler => needs the browser.
export function Counter({ start }: { start: number }) {
  const [n, setN] = useState(start)
  return (
    <button id="counter" onClick={() => setN(n + 1)}>
      Count: {n}
    </button>
  )
}

// Non-component exports from a client module must pass through untouched.
export const LABEL = 'counter-module'
