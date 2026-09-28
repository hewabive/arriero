const SERVE_TARGET_ID_PREFIX = "serve:";

export function serveTargetId(instanceId: string): string {
  return `${SERVE_TARGET_ID_PREFIX}${instanceId}`;
}

export function serveTargetInstanceId(targetId: string): string | null {
  if (!targetId.startsWith(SERVE_TARGET_ID_PREFIX)) {
    return null;
  }
  return targetId.slice(SERVE_TARGET_ID_PREFIX.length) || null;
}
