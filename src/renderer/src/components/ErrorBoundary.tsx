import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/VStack";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last line of defence for the renderer (TRD Milestone 1). An uncaught render
 * error otherwise leaves a blank window with no explanation, which is the worst
 * possible outcome in an app whose unsaved work lives in that same process.
 *
 * The failure is forwarded to the main process log, which is the only sink an
 * offline app is allowed to have (NFR-SEC-10).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    void window.astryxDesktop?.log({
      level: "error",
      message: `Renderer error boundary caught: ${error.message}`,
      context: { stack: error.stack, componentStack: info.componentStack },
    });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <Center>
        <VStack gap={3}>
          <Heading level={2}>The editor hit an unexpected error</Heading>
          <Text type="body" color="secondary">
            Unsaved work is kept in autosave and is offered back on the next launch.
          </Text>
          <Text type="code">{error.message}</Text>
          <Button label="Reload window" variant="primary" onClick={this.handleReload} />
        </VStack>
      </Center>
    );
  }
}
