import { renderToString } from 'react-dom/server'
import { Page } from './Page'

export function render() {
  return renderToString(<Page />)
}
