import type { ApiProxyTargetModelGroup } from "@arriero/core";
import { Stack, TextInput } from "@mantine/core";

import {
  useEndpointModelCatalog,
  useEndpointModelOptions,
} from "./endpoint-model-catalog";
import { StatusTooltipIcon } from "./StatusTooltipIcon";
import {
  substringOptionsFilter,
  TouchAutocomplete,
  TouchSelect,
} from "./TouchCombobox";

export type EndpointModelSelection = {
  endpointId: string | null;
  model: string;
};

type EndpointModelPickerProps = {
  value: EndpointModelSelection;
  onChange: (
    next: EndpointModelSelection,
    group: ApiProxyTargetModelGroup | undefined,
  ) => void;
  includeManagerProxy?: boolean;
  endpointLabel?: string;
  modelLabel?: string;
  modelDescription?: string;
  disabled?: boolean;
};

export function EndpointModelPicker(props: EndpointModelPickerProps) {
  const { groups, endpointSelectData, isFetching } = useEndpointModelCatalog(
    props.includeManagerProxy ?? false,
  );
  const selectedGroup = groups.find(
    (group) => group.endpointId === props.value.endpointId,
  );
  const { modelOptions, status } = useEndpointModelOptions({
    endpointId: props.value.endpointId,
    group: selectedGroup,
  });

  const selectEndpoint = (endpointId: string | null) => {
    const group = groups.find((item) => item.endpointId === endpointId);
    const model =
      group?.modelSource === "implied" ? (group.impliedModel ?? "") : "";
    props.onChange({ endpointId: endpointId || null, model }, group);
  };

  return (
    <Stack gap="sm">
      <TouchSelect
        label={props.endpointLabel ?? "Endpoint / provider"}
        data={endpointSelectData}
        value={props.value.endpointId}
        searchable
        clearable
        disabled={props.disabled ?? false}
        placeholder="Select an endpoint"
        nothingFoundMessage="No endpoints — add an instance or external API first"
        floatingHeight="viewport"
        loading={isFetching}
        onChange={selectEndpoint}
      />
      {selectedGroup?.modelSource === "implied" ? (
        <TextInput
          label={props.modelLabel ?? "Model"}
          description="Implied by the instance"
          value={selectedGroup.impliedModel ?? ""}
          readOnly
          disabled
        />
      ) : (
        <TouchAutocomplete
          label={props.modelLabel ?? "Model"}
          data={modelOptions.map((option) => option.value)}
          value={props.value.model}
          filter={substringOptionsFilter}
          openOnFocus
          disabled={(props.disabled ?? false) || !selectedGroup}
          placeholder={
            selectedGroup
              ? "Pick a model or type an id"
              : "Select an endpoint first"
          }
          rightSection={<StatusTooltipIcon status={status} />}
          rightSectionPointerEvents="all"
          floatingHeight="viewport"
          onChange={(model) =>
            props.onChange(
              { endpointId: props.value.endpointId, model },
              selectedGroup,
            )
          }
          {...(props.modelDescription
            ? { description: props.modelDescription }
            : {})}
        />
      )}
    </Stack>
  );
}
