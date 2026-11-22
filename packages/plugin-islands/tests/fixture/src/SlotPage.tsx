import { Card } from './Card'
import { ClientCard } from './ClientCard'

// slotAsFallback is a reserved call-site prop the plugin strips; it and
// fallback are spread so the fixture type-checks without declaring them.
export function SlotPage() {
  return (
    <main>
      <Card title="ssr">
        <p id="kid-ssr">static kid</p>
      </Card>
      <ClientCard title="client">
        <p id="kid-client">client kid</p>
      </ClientCard>
      <ClientCard title="inert" {...{ slotAsFallback: false }}>
        <p id="kid-inert">inert kid</p>
      </ClientCard>
      <ClientCard
        title="withfb"
        {...{
          fallback: {
            placeholder: <p id="own-placeholder">own placeholder</p>,
          },
        }}
      >
        <p id="kid-withfb">withfb kid</p>
      </ClientCard>
    </main>
  )
}
