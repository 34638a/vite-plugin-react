'use client'

// Its loading conditions come from the `defaultOn` option of the test config.
export function Defaulted({ name }: { name: string }) {
  return <button data-name={name}>{name}</button>
}
