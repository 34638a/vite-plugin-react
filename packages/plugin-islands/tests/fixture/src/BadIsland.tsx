'use client'
import { secret } from './server-only'
export function BadIsland() {
  secret()
  return null
}
