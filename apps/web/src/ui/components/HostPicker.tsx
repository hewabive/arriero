import type { NetworkInterfaceAddress } from "@arriero/core";
import { Stack, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { listNetworkInterfaces } from "../../api/client";
import { TouchSelect } from "./TouchCombobox";

const customHostSelectValue = "__custom_host__";

function hostOptionLabel(item: NetworkInterfaceAddress) {
  const parts = [item.address, item.name];
  if (item.cidr) {
    parts.push(item.cidr);
  }
  if (item.internal) {
    parts.push("internal");
  }
  return parts.join(" - ");
}

function hostOptionsFromInterfaces(
  interfaces: NetworkInterfaceAddress[] | undefined,
) {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  const add = (value: string, label: string) => {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    options.push({ value, label });
  };

  add("127.0.0.1", "127.0.0.1 - local machine only");
  add("0.0.0.0", "0.0.0.0 - all IPv4 interfaces");

  for (const item of interfaces ?? []) {
    if (item.address === "127.0.0.1" || item.address === "0.0.0.0") {
      continue;
    }
    add(item.address, hostOptionLabel(item));
  }

  return options;
}

export function HostPicker(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [customMode, setCustomMode] = useState(false);
  const interfacesQuery = useQuery({
    queryKey: ["network-interfaces"],
    queryFn: listNetworkInterfaces,
    staleTime: 30_000,
    retry: false,
  });
  const options = useMemo(
    () => hostOptionsFromInterfaces(interfacesQuery.data?.data.interfaces),
    [interfacesQuery.data?.data.interfaces],
  );
  const knownValues = useMemo(
    () => new Set(options.map((option) => option.value)),
    [options],
  );
  const isKnownValue = knownValues.has(props.value);
  const selectValue =
    customMode || !isKnownValue ? customHostSelectValue : props.value;

  useEffect(() => {
    if (props.value && knownValues.has(props.value)) {
      setCustomMode(false);
    }
  }, [knownValues, props.value]);

  return (
    <Stack gap={4}>
      <TouchSelect
        label={props.label}
        searchable
        allowDeselect={false}
        value={selectValue}
        data={[
          ...options,
          { value: customHostSelectValue, label: "Custom host" },
        ]}
        onChange={(value) => {
          if (!value) {
            return;
          }
          if (value === customHostSelectValue) {
            setCustomMode(true);
            if (isKnownValue) {
              props.onChange("");
            }
            return;
          }

          setCustomMode(false);
          props.onChange(value);
        }}
        nothingFoundMessage={
          interfacesQuery.isFetching
            ? "Loading interfaces..."
            : "No hosts found"
        }
      />
      {selectValue === customHostSelectValue && (
        <TextInput
          placeholder="192.168.1.10 or host name"
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        />
      )}
      {interfacesQuery.isError && (
        <Text c="yellow" size="xs">
          Network interfaces unavailable:{" "}
          {(interfacesQuery.error as Error).message}
        </Text>
      )}
    </Stack>
  );
}
