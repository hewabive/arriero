export async function forceReloadUi(): Promise<void> {
  const documentUrl = window.location.pathname + window.location.search;
  await fetch(documentUrl, {
    cache: "reload",
    credentials: "same-origin",
  }).catch(() => undefined);
  window.location.reload();
}
