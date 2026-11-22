import { renderToString } from 'react-dom/server'
import { FallbackPage } from './FallbackPage'
import { Page } from './Page'

export function render() {
  return renderToString(<Page />)
}

export function renderFallback() {
  return renderToString(<FallbackPage />)
}
