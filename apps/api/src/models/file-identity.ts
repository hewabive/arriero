export type ModelFileIdentity = { sizeBytes: number; modifiedAt: string };

export function fileIdentityFromStats(
  stats: Array<{ size: number; mtime: Date }>,
): ModelFileIdentity {
  return {
    sizeBytes: stats.reduce((sum, item) => sum + item.size, 0),
    modifiedAt: new Date(
      Math.max(...stats.map((item) => item.mtime.getTime())),
    ).toISOString(),
  };
}
