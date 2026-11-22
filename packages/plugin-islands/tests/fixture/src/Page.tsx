// No directive: a plain "server" module. Rendered to static HTML, never shipped.
import { Counter } from './Counter'
import Panel from './Panel'

export function Page() {
  return (
    <main>
      <h1 id="static">Static heading</h1>
      <Counter start={3} />
      <Panel title="Nested" />
    </main>
  )
}
