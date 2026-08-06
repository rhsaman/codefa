import type { CoderApi } from '../../electron/preload'

declare global {
  interface Window {
    coder: CoderApi
  }
}

export {}
