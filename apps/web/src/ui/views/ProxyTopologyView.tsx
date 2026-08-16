import type { ApiProxyPlanPreviewRequest } from "@arriero/core";
import { Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { previewApiProxyPlan } from "../../api/client";
import { useProxyConfig } from "../proxy/data";
import { SchedulerSection } from "../proxy/sections/index";
import { Topology } from "../proxy/Topology";
import { navigateProxy } from "../routing";

export function ProxyTopologyView() {
  const { models, pipelines, targets, targetById } = useProxyConfig();
  const [requestTargetId, setRequestTargetId] = useState<string | null>(null);

  const targetOptions = targets.map((target) => ({
    value: target.id,
    label: target.name,
  }));

  const planPreviewMutation = useMutation({
    mutationFn: previewApiProxyPlan,
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Plan check failed",
        message: (error as Error).message,
      }),
  });
  const planPreview = planPreviewMutation.data?.data;

  useEffect(() => {
    if (targets.length === 0) {
      setRequestTargetId(null);
      return;
    }
    if (
      !requestTargetId ||
      !targets.some((target) => target.id === requestTargetId)
    ) {
      setRequestTargetId(targets[0]?.id ?? null);
    }
  }, [requestTargetId, targets]);

  function previewSchedulerPlan(mode: ApiProxyPlanPreviewRequest["mode"]) {
    const input: ApiProxyPlanPreviewRequest = { mode };
    if (mode === "request" && requestTargetId) {
      input.requestedTargetId = requestTargetId;
    }
    planPreviewMutation.mutate(input);
  }

  return (
    <Stack gap="md">
      <Topology
        models={models}
        pipelines={pipelines}
        targets={targets}
        onOpenPipeline={(id) => navigateProxy(`pipelines/${id}`)}
      />

      <SchedulerSection
        targetOptions={targetOptions}
        requestTargetId={requestTargetId}
        planPreview={planPreview}
        targetById={targetById}
        previewPending={planPreviewMutation.isPending}
        onRequestTargetChange={setRequestTargetId}
        onPreviewRequest={() => previewSchedulerPlan("request")}
      />
    </Stack>
  );
}
