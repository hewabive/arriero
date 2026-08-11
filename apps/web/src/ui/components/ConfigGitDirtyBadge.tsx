import { Badge, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";

import { getConfigGitDirty } from "../../api/client";
import { countLabel } from "../utils/plural";

export function ConfigGitDirtyBadge() {
  const statusQuery = useQuery({
    queryKey: ["config-git-status", "dirty"],
    queryFn: getConfigGitDirty,
    refetchInterval: (query) =>
      query.state.data?.data.isGitRepo === false ? false : 30_000,
    retry: false,
  });
  const status = statusQuery.data?.data;
  if (!status?.isGitRepo || !status.dirty) {
    return null;
  }
  return (
    <Tooltip label="Configuration repository has uncommitted changes">
      <Badge
        component="button"
        color="yellow"
        variant="light"
        leftSection={<GitBranch size={12} />}
        style={{ cursor: "pointer" }}
        onClick={() => {
          window.location.hash = "/config-git";
        }}
      >
        {countLabel(status.fileCount, "uncommitted change")}
      </Badge>
    </Tooltip>
  );
}
