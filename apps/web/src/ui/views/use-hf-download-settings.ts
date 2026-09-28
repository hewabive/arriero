import type { HfDownloadSettings } from "@arriero/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getHfDownloadSettings,
  updateHfDownloadSettings,
} from "../../api/client";
import { notifyError } from "../utils/notify";

const DOWNLOAD_SETTINGS_QUERY_KEY = ["hf-download-settings"] as const;

export function useHfDownloadSettings(options: {
  errorTitle: string;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: DOWNLOAD_SETTINGS_QUERY_KEY,
    queryFn: getHfDownloadSettings,
  });
  const settings = query.data?.data ?? null;
  const mutation = useMutation({
    mutationFn: (patch: Partial<HfDownloadSettings>) => {
      if (!settings) {
        throw new Error("Download settings are not loaded");
      }
      return updateHfDownloadSettings({ ...settings, ...patch });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(DOWNLOAD_SETTINGS_QUERY_KEY, result);
      options.onSaved?.();
    },
    onError: notifyError(options.errorTitle),
  });
  return {
    settings,
    update: (patch: Partial<HfDownloadSettings>) => mutation.mutate(patch),
    pending: mutation.isPending,
    pendingPatch: mutation.isPending ? mutation.variables : null,
  };
}
