import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { listEnvironments, listWebapps } from "../../api/client";
import { WebappCreateModal } from "../components/WebappCreateModal";
import { useHashSubpath } from "../routing";
import { WebappsDiagnosticsView } from "./WebappsDiagnosticsView";
import { WebappsInstallView } from "./WebappsInstallView";
import { WebappsListView } from "./WebappsListView";

export function WebappsSection() {
  const [subpath, setSubpath] = useHashSubpath("webapps");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [createTarget, setCreateTarget] = useState<{
    environmentId: string | null;
  } | null>(null);

  const webappsQuery = useQuery({
    queryKey: ["webapps"],
    queryFn: listWebapps,
    refetchInterval: 2_500,
  });
  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: listEnvironments,
    refetchInterval: 2_500,
  });
  const webapps = webappsQuery.data?.data ?? [];
  const environments = environmentsQuery.data?.data ?? [];
  const selected =
    webapps.find((webapp) => webapp.name === selectedName) ??
    webapps[0] ??
    null;

  const head = subpath.split("/")[0] ?? "";

  return (
    <>
      {head === "diagnostics" ? (
        <WebappsDiagnosticsView
          webapps={webapps}
          selected={selected}
          environments={environments}
          onSelect={setSelectedName}
        />
      ) : head === "install" ? (
        <WebappsInstallView
          environments={environments}
          webapps={webapps}
          onAddWebapp={(environmentId) => setCreateTarget({ environmentId })}
        />
      ) : (
        <WebappsListView
          webapps={webapps}
          environments={environments}
          onCreate={(environmentId) => setCreateTarget({ environmentId })}
          onOpenInstall={() => setSubpath("install")}
          onOpenDiagnostics={(webapp) => {
            setSelectedName(webapp.name);
            setSubpath("diagnostics");
          }}
        />
      )}
      {createTarget && (
        <WebappCreateModal
          environments={environments}
          initialEnvironmentId={createTarget.environmentId}
          onCreated={(webapp) => {
            setSelectedName(webapp.name);
            setSubpath("");
          }}
          onOpenInstall={() => {
            setCreateTarget(null);
            setSubpath("install");
          }}
          onClose={() => setCreateTarget(null)}
        />
      )}
    </>
  );
}
