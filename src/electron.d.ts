import type { DropbeamApi } from './shared/contracts'

declare global {
  interface Window {
    dropbeam: DropbeamApi
  }
}