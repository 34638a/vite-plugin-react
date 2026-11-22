'use client'
import { Component, type ReactNode } from 'react'

function Bomb(): ReactNode {
  throw new Error('boom')
}

// What an island shows when it breaks is its own business: this one catches
// its own render failure and says so.
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <p id="own-failure">Exploder failed</p>
    ) : (
      this.props.children
    )
  }
}

// `fallback` is a reserved call-site prop the plugin strips; it is declared
// only so the fixture page type-checks.
export function Exploder(_props: { fallback?: unknown }): ReactNode {
  return (
    <Boundary>
      <Bomb />
    </Boundary>
  )
}
