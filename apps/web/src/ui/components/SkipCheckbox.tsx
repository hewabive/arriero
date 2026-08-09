import { Checkbox } from "@mantine/core";

export function SkipCheckbox(props: {
  label: string;
  description?: string;
  skipped: boolean;
  onSkipChange: (skip: boolean) => void;
}) {
  return (
    <Checkbox
      size="xs"
      label={props.label}
      {...(props.description ? { description: props.description } : {})}
      checked={!props.skipped}
      onChange={(event) => {
        const skip = !event.currentTarget.checked;
        props.onSkipChange(skip);
      }}
    />
  );
}
