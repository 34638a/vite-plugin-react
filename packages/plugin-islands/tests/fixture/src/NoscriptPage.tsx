import { ClientCard } from './ClientCard'

// The fallback props are reserved call-site props the plugin strips; they are
// spread so the fixture type-checks without declaring them on the component.
export function NoscriptPage() {
  return (
    <main>
      <ClientCard
        title="explicit"
        {...{
          fallback: {
            placeholder: <p id="ph-explicit">placeholder</p>,
            noscript: <p id="ns-explicit">no js</p>,
          },
        }}
      />
      <ClientCard title="plain">
        <p id="kid-plain">plain kid</p>
      </ClientCard>
      <ClientCard
        title="slotns"
        {...{
          fallback: { placeholder: <p id="ph-slotns">ph</p> },
          slotAsNoScript: true,
        }}
      >
        <p id="kid-slotns">slotns kid</p>
      </ClientCard>
      <ClientCard
        title="fbns"
        {...{
          fallback: { placeholder: <p id="ph-fbns">ph copy</p> },
          fallbackAsNoScript: true,
        }}
      />
      <ClientCard title="dup" {...{ slotAsNoScript: true }}>
        <p id="kid-dup">dup kid</p>
      </ClientCard>
    </main>
  )
}
