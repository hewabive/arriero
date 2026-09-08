import {
  defaultApiProxyTokenCountConfig,
  type ApiProxyTargetRecord,
  type ApiProxyTokenCountConfig,
} from "@arriero/core";
import { Select } from "@mantine/core";

export function TokenCountFields(props: {
  value: ApiProxyTokenCountConfig | undefined;
  targets: ApiProxyTargetRecord[];
  onChange: (value: ApiProxyTokenCountConfig) => void;
}) {
  const value = props.value ?? defaultApiProxyTokenCountConfig;
  const selectedTarget = value.targetId;
  const targetOptions = props.targets.map((target) => ({
    value: target.id,
    label: target.name,
  }));
  if (
    selectedTarget &&
    !props.targets.some((target) => target.id === selectedTarget)
  ) {
    targetOptions.push({
      value: selectedTarget,
      label: `Missing target (${selectedTarget})`,
    });
  }
  return (
    <>
      <Select
        label="Token counting"
        value={value.mode}
        data={[
          { value: "auto", label: "Upstream when available" },
          { value: "local", label: "Local estimate" },
        ]}
        onChange={(mode) =>
          props.onChange({
            ...value,
            mode: mode === "local" ? "local" : "auto",
          })
        }
      />
      {value.mode === "auto" && (
        <>
          <Select
            label="Count tokens for"
            description="Auto uses the only downstream target. For overflow routing from A to B, select A."
            placeholder="Auto: only downstream target"
            clearable
            searchable
            value={value.targetId}
            data={targetOptions}
            onChange={(targetId) => props.onChange({ ...value, targetId })}
          />
          <Select
            label="When exact counting is unavailable"
            description="Upstream counting supports text chat on llama.cpp, SGLang and vLLM. The route trace records counts, confirmed bounds and fallback."
            value={value.onUnavailable}
            data={[
              { value: "estimate", label: "Use local estimate" },
              { value: "error", label: "Return an error" },
            ]}
            onChange={(onUnavailable) =>
              props.onChange({
                ...value,
                onUnavailable: onUnavailable === "error" ? "error" : "estimate",
              })
            }
          />
        </>
      )}
    </>
  );
}
