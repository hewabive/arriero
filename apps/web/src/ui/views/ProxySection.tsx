import { useHashSubpath } from "../routing";
import { ApiEndpointsView } from "./ApiEndpointsView";
import { ApiProxySourcesView } from "./ApiProxySourcesView";
import { ProxyDashboardView } from "./ProxyView";
import { ProxyModelsView } from "./ProxyModelsView";
import { ProxyPipelinesView } from "./ProxyPipelinesView";
import { ProxyTargetsView } from "./ProxyTargetsView";
import { ProxyTracesView } from "./ProxyTracesView";
import { ResourcesView } from "./ResourcesView";

function splitHead(subpath: string): { head: string; rest: string } {
  const [head = "", ...tail] = subpath.split("/");
  return { head, rest: tail.join("/") };
}

export function ProxySection() {
  const [subpath, setSubpath] = useHashSubpath("proxy");
  const { head, rest } = splitHead(subpath);

  if (head === "traces") {
    return <ProxyTracesView />;
  }

  if (head === "models") {
    return <ProxyModelsView />;
  }

  if (head === "pipelines") {
    return (
      <ProxyPipelinesView
        subpath={rest}
        setSubpath={(next) =>
          setSubpath(next ? `pipelines/${next}` : "pipelines")
        }
      />
    );
  }

  if (head === "targets") {
    return <ProxyTargetsView />;
  }

  if (head === "endpoints") {
    return <ApiEndpointsView />;
  }

  if (head === "sources") {
    return <ApiProxySourcesView />;
  }

  if (head === "resources") {
    return <ResourcesView />;
  }

  return <ProxyDashboardView />;
}
