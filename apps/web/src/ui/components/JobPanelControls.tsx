import { ActionIcon, Tooltip, type ActionIconProps } from "@mantine/core";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function useJobPanelCollapse(
  jobId: string | null,
  succeeded: boolean,
): [boolean, () => void] {
  const [opened, setOpened] = useState(!succeeded);
  const previousJobIdRef = useRef(jobId);

  useEffect(() => {
    if (!jobId) return;
    if (previousJobIdRef.current !== jobId) {
      previousJobIdRef.current = jobId;
      setOpened(!succeeded);
      return;
    }
    if (succeeded) {
      setOpened(false);
    }
  }, [jobId, succeeded]);

  return [opened, () => setOpened((value) => !value)];
}

export function JobPanelControls(props: {
  subject: string;
  opened: boolean;
  onToggle: () => void;
  onDismiss?: (() => void) | undefined;
  size?: ActionIconProps["size"] | undefined;
}) {
  const sizeProps = props.size !== undefined ? { size: props.size } : {};
  return (
    <>
      <Tooltip label={props.opened ? "Collapse details" : "Expand details"}>
        <ActionIcon
          {...sizeProps}
          variant="subtle"
          color="gray"
          onClick={props.onToggle}
          aria-label={`${props.opened ? "Collapse" : "Expand"} ${props.subject} details`}
        >
          <ChevronDown
            size={16}
            style={{
              transform: props.opened ? "rotate(180deg)" : undefined,
              transition: "transform 150ms ease",
            }}
          />
        </ActionIcon>
      </Tooltip>
      {props.onDismiss && (
        <Tooltip label="Dismiss">
          <ActionIcon
            {...sizeProps}
            variant="subtle"
            color="gray"
            onClick={props.onDismiss}
            aria-label={`Dismiss ${props.subject} result`}
          >
            <X size={16} />
          </ActionIcon>
        </Tooltip>
      )}
    </>
  );
}
