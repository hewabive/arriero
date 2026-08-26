import { type EnvironmentRecord, type Webapp } from "@arriero/core";
import { Stack, Text } from "@mantine/core";

import { TouchSelect } from "../components/TouchCombobox";
import { WebappDetails } from "../components/WebappDetails";

export function WebappsDiagnosticsView({
  webapps,
  selected,
  environments,
  onSelect,
}: {
  webapps: Webapp[];
  selected: Webapp | null;
  environments: EnvironmentRecord[];
  onSelect: (name: string) => void;
}) {
  return (
    <Stack gap="md">
      <TouchSelect
        label="Web app"
        data={webapps.map((webapp) => ({
          value: webapp.name,
          label: webapp.name,
        }))}
        value={selected?.name ?? null}
        searchable
        disabled={webapps.length === 0}
        onChange={(value) => {
          if (value) {
            onSelect(value);
          }
        }}
      />
      {selected ? (
        <WebappDetails
          webapp={selected}
          environment={
            environments.find(
              (environment) => environment.id === selected.envSpecId,
            ) ?? null
          }
        />
      ) : (
        <Text c="dimmed">No web apps yet — add one on the Web apps tab.</Text>
      )}
    </Stack>
  );
}
