import { renderToString } from 'react-dom/server'
import { FallbackPage } from './FallbackPage'
import { LoadPage } from './LoadPage'
import { Page } from './Page'

export function render() {
  return renderToString(<Page />)
}

export function renderFallback() {
  return renderToString(<FallbackPage />)
}

export function renderLoad() {
  return renderToString(<LoadPage />)
}
