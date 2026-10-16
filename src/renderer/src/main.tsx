import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/globals.css";

import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

const container = document.getElementById("root");
if (!container) {
  throw new Error('Renderer mount point "#root" is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
