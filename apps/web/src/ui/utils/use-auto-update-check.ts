import { useEffect, useRef } from "react";

const AUTO_CHECK_STALE_MS = 15 * 60_000;

export function useAutoUpdateCheck(
  ready: boolean,
  lastCheckedAt: string | null,
  run: () => void,
) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current || !ready) {
      return;
    }
    firedRef.current = true;
    const checkedAt = lastCheckedAt ? Date.parse(lastCheckedAt) : Number.NaN;
    if (
      !Number.isFinite(checkedAt) ||
      Date.now() - checkedAt > AUTO_CHECK_STALE_MS
    ) {
      run();
    }
  }, [ready, lastCheckedAt, run]);
}
