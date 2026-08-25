import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { useEffect } from "react";

import { SELF_NODE_ID } from "../../api/base.js";
import { listNodes } from "../../api/client";
import { useActiveNode } from "../NodeContext";

export function NodeSwitcher() {
  const { activeNodeId, setActiveNode } = useActiveNode();
  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: listNodes,
    staleTime: 10_000,
  });

  const nodes = nodesQuery.data?.data ?? [];
  const enabledNodes = nodes.filter((node) => node.enabled && !node.self);

  useEffect(() => {
    const list = nodesQuery.data?.data;
    if (!list) {
      return;
    }
    if (
      activeNodeId !== SELF_NODE_ID &&
      !list.some(
        (node) => node.enabled && !node.self && node.id === activeNodeId,
      )
    ) {
      setActiveNode(SELF_NODE_ID);
    }
  }, [activeNodeId, nodesQuery.data, setActiveNode]);

  if (enabledNodes.length === 0) {
    return null;
  }

  const data = [
    { value: SELF_NODE_ID, label: "This node" },
    ...enabledNodes.map((node) => ({ value: node.id, label: node.name })),
  ];

  return (
    <Select
      size="xs"
      w={170}
      data={data}
      value={activeNodeId}
      allowDeselect={false}
      leftSection={<Server size={14} />}
      aria-label="Active node"
      onChange={(value) => {
        if (value) {
          setActiveNode(value);
        }
      }}
    />
  );
}
