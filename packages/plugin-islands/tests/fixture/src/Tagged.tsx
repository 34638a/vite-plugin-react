'use client'
import { useState } from 'react'

// Server-rendered (it has markup to watch) and interactive once loaded.
export function Tagged({ name }: { name: string }) {
  const [n, setN] = useState(0)
  return (
    <button data-name={name} onClick={() => setN((c) => c + 1)}>
      {name}: {n}
    </button>
  )
}
