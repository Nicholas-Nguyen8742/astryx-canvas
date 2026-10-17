import type { DesktopApi } from "../../../shared/ipc";

declare global {
  interface Window {
    /** Exposed by `src/preload/index.ts` through contextBridge. */
    readonly astryxDesktop: DesktopApi;
  }

  // In a browser context `window` and `globalThis` are the same object, but
  // TypeScript does not infer that from the Window augmentation above. The E2E
  // suite reaches the bridge through `globalThis` inside `page.evaluate`, where
  // there is no `window` binding in scope, so it needs this declaration too.
  // `var` is the only form that lands on the global object.
  var astryxDesktop: DesktopApi;
}

export {};
