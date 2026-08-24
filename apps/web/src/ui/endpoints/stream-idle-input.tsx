import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "@arriero/core";
import { NumberInput } from "@mantine/core";

export const DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS =
  DEFAULT_STREAM_IDLE_TIMEOUT_MS / 1000;

export function streamIdleSecondsFromMs(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms / 1000);
}

export function streamIdleMsFromSeconds(seconds: number | null): number | null {
  return seconds === null ? null : seconds * 1000;
}

export function StreamIdleTimeoutInput(props: {
  description: string;
  placeholder: string;
  value: number | null;
  onChange: (seconds: number | null) => void;
  disabled?: boolean;
  onBlur?: () => void;
  maw?: number;
}) {
  return (
    <NumberInput
      label="Stream idle timeout (seconds)"
      description={props.description}
      placeholder={props.placeholder}
      min={0}
      max={3600}
      allowDecimal={false}
      value={props.value ?? ""}
      disabled={props.disabled ?? false}
      onChange={(value) =>
        props.onChange(typeof value === "number" ? value : null)
      }
      {...(props.onBlur ? { onBlur: props.onBlur } : {})}
      {...(props.maw === undefined ? {} : { maw: props.maw })}
    />
  );
}
