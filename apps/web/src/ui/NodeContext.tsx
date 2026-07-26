import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

import { SELF_NODE_ID, getActiveNodeId, setActiveNodeId } from "../api/base.js";

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

export function NodeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [activeNodeId, setActiveNodeIdState] = useState<string>(() =>
    getActiveNodeId(),
  );

  const setActiveNode = useCallback(
    (id: string) => {
      setActiveNodeId(id);
      setActiveNodeIdState(getActiveNodeId());
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  return (
    <NodeContext.Provider value={{ activeNodeId, setActiveNode }}>
      {children}
    </NodeContext.Provider>
  );
}
