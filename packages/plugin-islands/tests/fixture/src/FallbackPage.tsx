import { ClientCounter } from './ClientCounter'
import { Exploder } from './Exploder'

const fallback = {
  placeholder: <p id="placeholder-cc">Counter placeholder</p>,
  noscript: <p id="noscript-cc">Enable JavaScript</p>,
}

export function FallbackPage() {
  return (
    <main>
      <ClientCounter start={5} {...{ fallback }} />
      <Exploder
        {...{
          fallback: { placeholder: <p id="placeholder-ex">Placeholder</p> },
        }}
      />
    </main>
  )
}
