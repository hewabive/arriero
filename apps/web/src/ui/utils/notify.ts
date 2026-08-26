import { notifications } from "@mantine/notifications";

function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function notifyError(title: string) {
  return (error: unknown) =>
    notifications.show({
      color: "red",
      title,
      message: errorMessageText(error),
    });
}
