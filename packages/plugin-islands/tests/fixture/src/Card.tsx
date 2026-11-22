'use client'
import { useState, type ReactNode } from 'react'

// Takes `children`: static content the server rendered into the marker.
// Ids come from `title` so one page can hold several.
export function Card({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  const [n, setN] = useState(0)
  return (
    <section>
      <h2>{title}</h2>
      <button data-card={title} onClick={() => setN((c) => c + 1)}>
        {n}
      </button>
      <div id={`slot-${title}`}>{children}</div>
    </section>
  )
}
