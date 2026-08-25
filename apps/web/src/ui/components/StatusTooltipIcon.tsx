import { Loader, ThemeIcon, Tooltip } from "@mantine/core";
import { Check, X } from "lucide-react";

export type TooltipIconStatus = {
  state: "idle" | "loading" | "ok" | "error";
  label: string;
};

export function StatusTooltipIcon(props: { status: TooltipIconStatus }) {
  const { status } = props;
  if (status.state === "loading") {
    return (
      <Tooltip label={status.label} multiline maw={360}>
        <Loader size={16} />
      </Tooltip>
    );
  }

  const ok = status.state === "ok";
  return (
    <Tooltip label={status.label} multiline maw={360} interactive>
      <ThemeIcon
        color={ok ? "green" : status.state === "idle" ? "gray" : "red"}
        radius="xl"
        size={22}
        variant="light"
      >
        {ok ? <Check size={14} /> : <X size={14} />}
      </ThemeIcon>
    </Tooltip>
  );
}
