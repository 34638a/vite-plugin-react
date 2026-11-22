'use client'
import { Counter } from './Counter'

// Client component that imports another client component (nested boundary):
// must produce ONE marker, not two.
export default function Panel({ title }: { title: string }) {
  return (
    <section id="panel">
      <h2>{title}</h2>
      <Counter start={10} />
    </section>
  )
}
