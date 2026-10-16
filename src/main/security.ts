import { session, type WebContents } from "electron";

import type { FileLogger } from "./logger";

/**
 * CSP is delivered as a response header rather than a <meta> tag so it also
 * governs the production `file://` load, where meta-based CSP is unreliable.
 */
const SHARED_DIRECTIVES = [
  "default-src 'self'",
  // Astryx's Theme provider injects component overrides through a <style> tag at
  // runtime, which cannot be expressed as a nonce without forking the library.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // No remote font sources: this is what makes the Google Fonts @import shipped
  // by the theme packages a hard failure rather than a silent network call.
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

const PRODUCTION_DIRECTIVES = ["script-src 'self'", "connect-src 'none'"];

export function contentSecurityPolicy(mode: "development" | "production", devServerUrl?: string): string {
  if (mode === "production") {
    return [...SHARED_DIRECTIVES, ...PRODUCTION_DIRECTIVES].join("; ");
  }

  // Development has to allow the Vite HMR socket and the inline preamble that
  // @vitejs/plugin-react injects. Neither is reachable from a packaged build,
  // where connect-src 'none' is what enforces the offline mandate.
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : "http://localhost:*";
  const devDirectives = [
    "script-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${devOrigin} ws://localhost:* ws://127.0.0.1:*`,
  ];
  return [...SHARED_DIRECTIVES, ...devDirectives].join("; ");
}

export function applyContentSecurityPolicy(policy: string): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

/**
 * Locks a renderer down to the app itself (TRD §18.1): no navigation away, no
 * child windows. Everything is logged, nothing is silently dropped.
 */
export function hardenWebContents(contents: WebContents, logger: FileLogger): void {
  contents.on("will-navigate", (event, url) => {
    const current = contents.getURL();
    if (url !== current) {
      event.preventDefault();
      logger.warn("Blocked renderer navigation", { from: current, to: url });
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    // An offline editor has no legitimate reason to spawn a window, and opening
    // the system browser from here would be an unrequested network action.
    logger.warn("Blocked window.open", { url });
    return { action: "deny" };
  });
}
