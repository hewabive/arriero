import type { FleetNodeView } from "@arriero/core";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { SELF_NODE_ID, getActiveNodeId, setActiveNodeId } from "../api/base.js";
import { listNodes } from "../api/nodes.js";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { scope?: "self" };
  }
}

type NodeContextValue = {
  activeNodeId: string;
  setActiveNode: (id: string) => void;
};

const NodeContext = createContext<NodeContextValue>({
  activeNodeId: SELF_NODE_ID,
  setActiveNode: () => {},
});

export function useActiveNode() {
  return useContext(NodeContext);
}

export function useActiveFleetNode(): FleetNodeView | null {
  const { activeNodeId } = useActiveNode();
  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: listNodes,
    staleTime: 10_000,
    meta: { scope: "self" },
    enabled: activeNodeId !== SELF_NODE_ID,
  });
  if (activeNodeId === SELF_NODE_ID) {
    return null;
  }
  return nodesQuery.data?.data.find((node) => node.id === activeNodeId) ?? null;
}

export function useActiveNodeHost(): string | null {
  const { activeNodeId } = useActiveNode();
  const node = useActiveFleetNode();
  if (activeNodeId === SELF_NODE_ID) {
    return typeof window === "undefined" ? null : window.location.hostname;
  }
  return node ? new URL(node.baseUrl).hostname : null;
}

function followsActiveNode(query: Query): boolean {
  return query.meta?.scope !== "self";
}

export function NodeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [activeNodeId, setActiveNodeIdState] = useState<string>(() =>
    getActiveNodeId(),
  );

  const setActiveNode = useCallback(
    (id: string) => {
      const previousNodeId = getActiveNodeId();
      setActiveNodeId(id);
      if (getActiveNodeId() === previousNodeId) {
        return;
      }
      for (const query of queryClient
        .getQueryCache()
        .findAll({ predicate: followsActiveNode })) {
        query.reset();
      }
      setActiveNodeIdState(getActiveNodeId());
    },
    [queryClient],
  );

  useEffect(() => {
    void queryClient.refetchQueries(
      { predicate: followsActiveNode, type: "active" },
      { cancelRefetch: false },
    );
  }, [activeNodeId, queryClient]);

  return (
    <NodeContext.Provider value={{ activeNodeId, setActiveNode }}>
      {children}
    </NodeContext.Provider>
  );
}
