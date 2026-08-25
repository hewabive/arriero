import { Alert, Button, Center, Loader, Stack, Text } from "@mantine/core";
import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type PropsWithChildren,
} from "react";

import type { PipelineCanvasProps } from "./PipelineCanvas";
import { forceReloadUi } from "../../utils/reload";

const CanvasComponent = lazy(async () => ({
  default: (await import("./PipelineCanvas")).PipelineCanvas,
}));

export function prefetchPipelineCanvas(): void {
  void import("./PipelineCanvas").catch((error: unknown) => {
    console.error("Pipeline canvas prefetch failed", error);
  });
}

type CanvasLoadBoundaryState = {
  failed: boolean;
};

class CanvasLoadBoundary extends Component<
  PropsWithChildren,
  CanvasLoadBoundaryState
> {
  state: CanvasLoadBoundaryState = { failed: false };

  static getDerivedStateFromError(): CanvasLoadBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Pipeline canvas failed to load", error, info);
  }

  override render() {
    if (this.state.failed) {
      return (
        <Alert color="red" title="Canvas failed to load">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">
              The UI build on the server may be newer than this tab.
            </Text>
            <Button
              size="compact-sm"
              variant="light"
              color="red"
              onClick={() => void forceReloadUi()}
            >
              Reload to load the updated UI
            </Button>
          </Stack>
        </Alert>
      );
    }
    return this.props.children;
  }
}

export function LazyPipelineCanvas(props: PipelineCanvasProps) {
  return (
    <CanvasLoadBoundary>
      <Suspense
        fallback={
          <Center mih="45vh">
            <Loader />
          </Center>
        }
      >
        <CanvasComponent {...props} />
      </Suspense>
    </CanvasLoadBoundary>
  );
}
