/// <reference types="vite/client" />

import type { DesktopHostBridge } from "@0/shared"

declare global {
  interface Window {
    readonly osecDesktop?: DesktopHostBridge;
  }
}