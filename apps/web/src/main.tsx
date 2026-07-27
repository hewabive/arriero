import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./styles.css";

import { createTheme, MantineProvider, Tooltip } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./ui/App";
import { NodeProvider } from "./ui/NodeContext";

const queryClient = new QueryClient();

const theme = createTheme({
  components: {
    Tooltip: Tooltip.extend({
      defaultProps: { events: { hover: true, focus: true, touch: true } },
    }),
  },
});

type RootErrorBoundaryState = {
  error: Error | null;
};

class RootErrorBoundary extends React.Component<
  React.PropsWithChildren,
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled UI error", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="root-error">
          <div>
            <p className="root-error__eyebrow">arriero</p>
            <h1>UI render error</h1>
            <p>{this.state.error.message}</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <NodeProvider>
        <MantineProvider theme={theme} defaultColorScheme="dark">
          <RootErrorBoundary>
            <Notifications position="top-right" />
            <App />
          </RootErrorBoundary>
        </MantineProvider>
      </NodeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
