import { INSTANCE_KINDS, engineDescriptor } from "@arriero/core";
import {
  Autocomplete,
  Box,
  Button,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { Triangle } from "lucide-react";

import { InstanceFormArgumentsSection } from "./InstanceFormArgumentsSection";
import { InstanceFormCudaSection } from "./InstanceFormCudaSection";
import { InstanceFormEnvSection } from "./InstanceFormEnvSection";
import { InstanceFormHostPort } from "./InstanceFormHostPort";
import { InstanceFormKTransformersSection } from "./InstanceFormKTransformersSection";
import { InstanceFormMemorySection } from "./InstanceFormMemorySection";
import { InstanceFormModelSection } from "./InstanceFormModelSection";
import { InstanceFormNumaSection } from "./InstanceFormNumaSection";
import { InstanceFormPreflightSection } from "./InstanceFormPreflightSection";
import { InstanceFormRenameSection } from "./InstanceFormRenameSection";
import { InstanceFormRpcWorkersSection } from "./InstanceFormRpcWorkersSection";
import { InstanceFormSchedulingSection } from "./InstanceFormSchedulingSection";
import { InstanceFormSpecSection } from "./InstanceFormSpecSection";
import { InstanceFormWorkerEndpointSection } from "./InstanceFormWorkerEndpointSection";
import { ReasoningOverrideSelect } from "./ReasoningOverrideSelect";
import { TouchSelect } from "./TouchCombobox";
import {
  useInstanceForm,
  type InstanceFormModalProps,
} from "./use-instance-form";

export function InstanceFormModal(props: InstanceFormModalProps) {
  const fm = useInstanceForm(props);

  if (fm.waitingForInitialDefaults) {
    return (
      <Modal
        opened={props.opened}
        onClose={props.onClose}
        title={fm.modalTitle}
        size="lg"
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Text c="dimmed" size="sm">
          Loading default arguments...
        </Text>
      </Modal>
    );
  }

  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title={fm.modalTitle}
      size="lg"
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <form onSubmit={fm.form.onSubmit(fm.submit)}>
        <Stack gap="sm">
          <SegmentedControl
            fullWidth
            value={fm.kind}
            onChange={(value) => fm.applyKind(value as typeof fm.kind)}
            disabled={fm.isEdit}
            data={INSTANCE_KINDS.filter(
              (kind) => engineDescriptor(kind).form.creatable,
            ).map((kind) => ({
              label: kind,
              value: kind,
            }))}
          />
          <TextInput
            label="Name"
            required
            description="Used as the config file name: letters, digits, dot, underscore, hyphen"
            {...fm.form.getInputProps("name")}
          />
          <InstanceFormRenameSection fm={fm} />
          <TouchSelect
            label="Binary"
            required
            description="Managed in the Path catalog page; the working directory defaults to the binary's folder."
            placeholder={
              fm.pathCatalogQuery.isFetching
                ? "Loading catalog..."
                : "Select a binary from the catalog"
            }
            searchable
            loading={fm.pathCatalogQuery.isFetching}
            value={fm.selectedBinaryPathRefId}
            onChange={fm.applyBinaryPathRef}
            data={fm.binaryCatalogOptions}
            nothingFoundMessage="No binaries in catalog"
          />
          {!fm.pathCatalogQuery.isFetching &&
            fm.binaryCatalogOptions.length === 0 && (
              <Text c="yellow" size="xs">
                No binaries for this engine are in the catalog. Add one on the
                Path catalog page or create a managed environment.
              </Text>
            )}
          <TextInput
            label="Working directory"
            description="Optional override for the process working directory; empty runs in the binary's folder"
            placeholder="/path/to/workdir"
            value={fm.cwd}
            onChange={(event) => {
              const value = event.currentTarget.value;
              fm.setCwd(value);
            }}
          />
          {fm.modelSource === "free-text" && fm.kind !== "ktransformers" && (
            <>
              <Autocomplete
                label="Model"
                required
                description="Hugging Face repository id or local safetensors directory"
                placeholder="Qwen/Qwen3-8B"
                data={fm.safetensorsPathOptions}
                limit={20}
                value={fm.modelReference}
                onChange={fm.setModelReference}
              />
              <InstanceFormHostPort fm={fm} />
            </>
          )}
          {fm.kind === "ktransformers" && (
            <>
              <InstanceFormKTransformersSection fm={fm} />
              <InstanceFormHostPort fm={fm} />
            </>
          )}
          {fm.modelSource === "gguf" && (
            <>
              <InstanceFormModelSection fm={fm} />
              <InstanceFormSpecSection fm={fm} />
              <InstanceFormRpcWorkersSection fm={fm} />
            </>
          )}
          {fm.modelSource === "none" && (
            <InstanceFormWorkerEndpointSection fm={fm} />
          )}
          {!fm.isWorker && <InstanceFormArgumentsSection fm={fm} />}
          <InstanceFormPreflightSection fm={fm} />
          <InstanceFormCudaSection fm={fm} />
          <InstanceFormNumaSection fm={fm} />
          <InstanceFormMemorySection fm={fm} />
          <InstanceFormSchedulingSection fm={fm} />
          {!fm.isWorker && (
            <ReasoningOverrideSelect
              value={fm.reasoning}
              onChange={fm.setReasoning}
              autoLabel="Auto (detect from the model's chat template)"
              description="How the proxy maps client-requested reasoning effort onto this instance; Auto derives the level ladder from the chat template, a preset overrides autodetection."
            />
          )}
          <InstanceFormEnvSection fm={fm} />
          <Group justify="space-between" mt="sm">
            <Box>
              {!fm.isEdit && (
                <Switch
                  label="Start after create"
                  checked={fm.startAfterCreate}
                  disabled={fm.mutation.isPending}
                  onChange={(event) =>
                    fm.setStartAfterCreate(event.currentTarget.checked)
                  }
                />
              )}
            </Box>
            <Group gap="xs">
              <Button
                variant="subtle"
                onClick={props.onClose}
                disabled={fm.mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={fm.mutation.isPending}
                leftSection={
                  !fm.isEdit && fm.startAfterCreate ? (
                    <Triangle size={16} fill="currentColor" />
                  ) : undefined
                }
              >
                {fm.isEdit
                  ? "Save"
                  : fm.startAfterCreate
                    ? "Create & Start"
                    : "Create"}
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
