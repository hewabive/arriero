function pad(value: number, length = 2) {
  return String(value).padStart(length, "0");
}

export function formatLocalClock(value: number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatLocalDateTime(
  value: string | number | Date | null | undefined,
) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return [
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${pad(date.getFullYear() % 100)}`,
    formatLocalClock(date),
  ].join(" ");
}

export function formatElapsed(startedAt: string, finishedAt: string | null) {
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function formatEtaSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  if (seconds < 60) {
    return `~${Math.max(1, Math.round(seconds))} s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `~${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `~${hours} h ${remainder} min` : `~${hours} h`;
}

export function formatLocalHour(utcHour: string | null | undefined) {
  if (!utcHour) {
    return "-";
  }

  const date = new Date(`${utcHour}:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return utcHour.replace("T", " ");
  }

  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${pad(date.getFullYear() % 100)} ${pad(date.getHours())}:00`;
}
