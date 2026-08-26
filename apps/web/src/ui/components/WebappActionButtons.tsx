import { type Webapp, type WebappDriftField } from "@arriero/core";
import { Badge, Button, Tooltip } from "@mantine/core";
import { ExternalLink } from "lucide-react";

import { browserReachableHost, urlHost } from "../utils/instance-url";
import { type WebappActions } from "./use-webapp-actions";

const DRIFT_FIELD_LABELS: Record<WebappDriftField, string> = {
  environment: "environment",
  arguments: "host/port",
  "data-dir": "data directory",
  "rendered-env": "rendered env",
};

export function WebappConfigDriftBadge({ webapp }: { webapp: Webapp }) {
  if (webapp.configDrift.length === 0) {
    return null;
  }
  const changed = webapp.configDrift
    .map((field) => DRIFT_FIELD_LABELS[field])
    .join(", ");
  return (
    <Tooltip label={`Changed since launch: ${changed}; restart to apply`}>
      <Badge color="yellow">config drift</Badge>
    </Tooltip>
  );
}

function webappUrl(webapp: Webapp): string {
  return `http://${urlHost(browserReachableHost(webapp.http.host))}:${webapp.http.port}/`;
}

export function envVersionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function envStatusColor(status: Webapp["envStatus"]): string {
  if (status === "installed") return "green";
  if (status === "installing") return "blue";
  if (status === "failed" || status === "missing-spec") return "red";
  return "gray";
}

export function WebappActionButtons({
  webapp,
  actions,
}: {
  webapp: Webapp;
  actions: WebappActions;
}) {
  return (
    <>
      {webapp.status === "running" && (
        <Button
          component="a"
          href={webappUrl(webapp)}
          target="_blank"
          rel="noreferrer"
          size="xs"
          variant="light"
          rightSection={<ExternalLink size={14} />}
        >
          Open
        </Button>
      )}
      {webapp.status === "running" || webapp.status === "starting" ? (
        <>
          <Button
            size="xs"
            variant="default"
            disabled={actions.pending}
            onClick={() => actions.restart.mutate(webapp.name)}
          >
            Restart
          </Button>
          <Button
            size="xs"
            color="red"
            variant="light"
            disabled={actions.pending}
            onClick={() => actions.stop.mutate(webapp.name)}
          >
            Stop
          </Button>
        </>
      ) : (
        <Button
          size="xs"
          disabled={actions.pending || webapp.envStatus !== "installed"}
          onClick={() => actions.start.mutate(webapp.name)}
        >
          Start
        </Button>
      )}
    </>
  );
}
