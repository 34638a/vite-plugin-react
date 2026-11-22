import { Tagged } from './Tagged'

const Space = () => <div style={{ height: 3000 }} />

// The on* props are reserved call-site props the plugin strips; they are
// spread so the fixture type-checks without declaring them on the component.
export function LoadPage() {
  return (
    <main>
      <Tagged name="eager" />
      <Tagged name="load" {...{ onLoad: true }} />
      <Tagged name="interaction" {...{ onInteraction: true }} />
      <Tagged name="media" {...{ onMedia: '(min-width: 5000px)' }} />
      <Tagged name="idle-1" {...{ onIdle: true }} />
      <Tagged name="idle-2" {...{ onIdle: true }} />
      <Space />
      <Tagged name="visible" {...{ onVisible: true }} />
      <Space />
      <Tagged
        name="hybrid"
        {...{ onIdle: true, onVisible: true, onAny: true }}
      />
      <Space />
      <Tagged name="and" {...{ onIdle: true, onVisible: true }} />
      <Space />
    </main>
  )
}
