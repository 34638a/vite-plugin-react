import { renderToString } from 'react-dom/server'
import { DefaultsPage } from './DefaultsPage'
import { FallbackPage } from './FallbackPage'
import { LoadPage } from './LoadPage'
import { NoscriptPage } from './NoscriptPage'
import { Page } from './Page'
import { SlotPage } from './SlotPage'

export function render() {
  return renderToString(<Page />)
}

export function renderFallback() {
  return renderToString(<FallbackPage />)
}

export function renderLoad() {
  return renderToString(<LoadPage />)
}

export function renderSlot() {
  return renderToString(<SlotPage />)
}

export function renderDefaults() {
  return renderToString(<DefaultsPage />)
}

export function renderNoscript() {
  return renderToString(<NoscriptPage />)
}
