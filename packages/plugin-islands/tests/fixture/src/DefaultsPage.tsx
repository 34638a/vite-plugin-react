import { Defaulted } from './Defaulted'

export function DefaultsPage() {
  return (
    <main>
      <Defaulted name="defaulted" />
      <Defaulted name="overridden" {...{ onMedia: '(min-width: 1px)' }} />
    </main>
  )
}
