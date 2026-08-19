import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect } from "react";

import { getSelfVersion } from "../api/client";
import { forceReloadUi } from "./utils/reload";

const PROMPTED_STORAGE_KEY = "arriero-ui-version-prompted";
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;

let lastCheckStartedAt = 0;

async function checkUiVersionOnce(): Promise<void> {
  const now = Date.now();
  if (now - lastCheckStartedAt < MIN_CHECK_GAP_MS) {
    return;
  }
  lastCheckStartedAt = now;

  let serverCommit: string | null;
  try {
    const version = (await getSelfVersion()).data;
    serverCommit = version.builtCommit ?? version.commit;
  } catch {
    return;
  }
  if (!serverCommit || serverCommit === __ARRIERO_UI_COMMIT__) {
    return;
  }

  const promptKey = `${__ARRIERO_UI_COMMIT__}:${serverCommit}`;
  if (window.sessionStorage.getItem(PROMPTED_STORAGE_KEY) === promptKey) {
    return;
  }
  window.sessionStorage.setItem(PROMPTED_STORAGE_KEY, promptKey);

  notifications.show({
    id: "ui-version-mismatch",
    title: "UI is out of date",
    color: "blue",
    autoClose: false,
    message: (
      <Button
        size="compact-sm"
        variant="light"
        onClick={() => void forceReloadUi()}
      >
        Reload to load the updated UI
      </Button>
    ),
  });
}

export function useUiVersionGuard(): void {
  useEffect(() => {
    if (import.meta.env.DEV || __ARRIERO_UI_COMMIT__ === "unknown") {
      return;
    }
    void checkUiVersionOnce();
    const interval = window.setInterval(
      () => void checkUiVersionOnce(),
      CHECK_INTERVAL_MS,
    );
    const onFocus = () => void checkUiVersionOnce();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
