import { stripGgufSuffix, type ApiProxyTargetModelGroup } from "@arriero/core";
import {
  Button,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  TextInput,
  Textarea,
} from "@mantine/core";
import { Save } from "lucide-react";

import type {
  ModelDraft,
  ModelEditor,
  QuickRouteDraft,
  TargetDraft,
  TargetEditor,
} from "./forms";
import { isEndpointRouteValue, unboundTargetValue } from "./forms";
import type { SelectOption } from "./sections/index";
import {
  EndpointModelPicker,
  type EndpointModelSelection,
} from "../components/EndpointModelPicker";
import { TouchSelect } from "../components/TouchCombobox";

function suggestName(
  model: string,
  group: ApiProxyTargetModelGroup | undefined,
): string {
  const trimmed = model.trim();
  if (trimmed) {
    return stripGgufSuffix(trimmed);
  }
  if (group?.impliedModel) {
    return stripGgufSuffix(group.impliedModel);
  }
  return group?.endpointName ?? "";
}

type ModelEditorModalProps = {
  editor: ModelEditor | null;
  draft: ModelDraft;
  routeToOptions: SelectOption[];
  busy: boolean;
  onClose: () => void;
  onSave: () => void;
  onDraftChange: (draft: ModelDraft) => void;
};

export function ModelEditorModal(props: ModelEditorModalProps) {
  return (
    <Modal
      opened={Boolean(props.editor)}
      onClose={props.onClose}
      title={
        props.editor?.mode === "edit"
          ? `Edit ${props.editor.model.modelId}`
          : "Add external model"
      }
      size="lg"
    >
      <Stack gap="sm">
        <TextInput
          label="Model ID"
          placeholder="Public model id for /v1/models"
          value={props.draft.modelId}
          onChange={(event) => {
            const modelId = event.currentTarget.value;
            props.onDraftChange({ ...props.draft, modelId });
          }}
        />
        <TextInput
          label="Owned by"
          value={props.draft.ownedBy}
          onChange={(event) => {
            const ownedBy = event.currentTarget.value;
            props.onDraftChange({ ...props.draft, ownedBy });
          }}
        />
        <TouchSelect
          label="Route to"
          data={props.routeToOptions}
          value={props.draft.routeToValue ?? unboundTargetValue}
          searchable
          onChange={(value) =>
            props.onDraftChange({
              ...props.draft,
              routeToValue:
                !value || value === unboundTargetValue ? null : value,
            })
          }
        />
        {isEndpointRouteValue(props.draft.routeToValue) && (
          <TextInput
            label="Upstream model"
            description="Model id sent to the endpoint; empty forwards the public model id unchanged"
            value={props.draft.upstreamModel}
            onChange={(event) => {
              const upstreamModel = event.currentTarget.value;
              props.onDraftChange({ ...props.draft, upstreamModel });
            }}
          />
        )}
        <TextInput
          label="Description"
          value={props.draft.description}
          onChange={(event) => {
            const description = event.currentTarget.value;
            props.onDraftChange({ ...props.draft, description });
          }}
        />
        <Switch
          label="Visible"
          description="Listed in GET /v1/models"
          checked={props.draft.visible}
          onChange={(event) => {
            const visible = event.currentTarget.checked;
            props.onDraftChange({ ...props.draft, visible });
          }}
        />
        <Switch
          label="Enabled"
          description="Serves requests; off responds model_disabled"
          checked={props.draft.enabled}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            props.onDraftChange({ ...props.draft, enabled });
          }}
        />
        <Textarea
          label="Blocked message"
          description="Returned to the caller while this model is disabled. Empty uses a default message."
          autosize
          minRows={1}
          value={props.draft.blockedMessage}
          onChange={(event) => {
            const blockedMessage = event.currentTarget.value;
            props.onDraftChange({ ...props.draft, blockedMessage });
          }}
        />
        <Group justify="flex-end">
          <Button variant="subtle" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            leftSection={<Save size={16} />}
            loading={props.busy}
            disabled={!props.draft.modelId.trim()}
            onClick={props.onSave}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type TargetEditorModalProps = {
  editor: TargetEditor | null;
  draft: TargetDraft;
  busy: boolean;
  slotSaveAvailable: boolean;
  onClose: () => void;
  onSave: () => void;
  onDraftChange: (draft: TargetDraft) => void;
};

export function TargetEditorModal(props: TargetEditorModalProps) {
  const isCreate = props.editor?.mode === "create";

  const handlePick = (
    selection: EndpointModelSelection,
    group: ApiProxyTargetModelGroup | undefined,
  ) => {
    const model = group?.kind === "external-api" ? selection.model : "";
    const name =
      isCreate && !props.draft.name.trim()
        ? suggestName(model, group)
        : props.draft.name;
    props.onDraftChange({
      ...props.draft,
      endpointId: selection.endpointId,
      model,
      name,
    });
  };

  return (
    <Modal
      opened={Boolean(props.editor)}
      onClose={props.onClose}
      title={
        props.editor?.mode === "edit"
          ? `Edit ${props.editor.target.name}`
          : "Add proxy target"
      }
      size="lg"
    >
      <Stack gap="sm">
        <TextInput
          label="Name"
          value={props.draft.name}
          onChange={(event) => {
            const name = event.currentTarget.value;
            props.onDraftChange({ ...props.draft, name });
          }}
        />
        <EndpointModelPicker
          value={{
            endpointId: props.draft.endpointId,
            model: props.draft.model,
          }}
          modelDescription="Single-model instances imply their model; pick a named model only for router instances or external APIs."
          onChange={handlePick}
        />
        <Group grow align="flex-end">
          <SegmentedControl
            value={props.draft.role}
            onChange={(value) =>
              props.onDraftChange({
                ...props.draft,
                role: value as TargetDraft["role"],
              })
            }
            data={[
              { value: "interactive", label: "Interactive" },
              { value: "background", label: "Background" },
            ]}
          />
          <NumberInput
            label="Priority"
            min={0}
            max={10_000}
            value={props.draft.priority}
            onChange={(value) =>
              props.onDraftChange({
                ...props.draft,
                priority: typeof value === "number" ? value : "",
              })
            }
          />
        </Group>
        <Group gap="lg" wrap="wrap">
          <Switch
            label="Preemptible"
            checked={props.draft.preemptible}
            onChange={(event) => {
              const preemptible = event.currentTarget.checked;
              props.onDraftChange({ ...props.draft, preemptible });
            }}
          />
          {props.slotSaveAvailable && (
            <Switch
              label="Save slots before unload"
              checked={props.draft.saveSlotsBeforeUnload}
              onChange={(event) => {
                const saveSlotsBeforeUnload = event.currentTarget.checked;
                props.onDraftChange({ ...props.draft, saveSlotsBeforeUnload });
              }}
            />
          )}
        </Group>
        {props.slotSaveAvailable && (
          <TextInput
            label="Slot IDs"
            placeholder="0, 1"
            value={props.draft.slotIds}
            onChange={(event) => {
              const slotIds = event.currentTarget.value;
              props.onDraftChange({ ...props.draft, slotIds });
            }}
          />
        )}
        <NumberInput
          label="Idle unload ms"
          min={0}
          value={props.draft.idleUnloadMs}
          onChange={(value) =>
            props.onDraftChange({
              ...props.draft,
              idleUnloadMs: typeof value === "number" ? value : "",
            })
          }
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            leftSection={<Save size={16} />}
            loading={props.busy}
            disabled={!props.draft.name.trim() || !props.draft.endpointId}
            onClick={props.onSave}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type QuickRouteModalProps = {
  opened: boolean;
  draft: QuickRouteDraft;
  busy: boolean;
  onClose: () => void;
  onCreate: () => void;
  onDraftChange: (draft: QuickRouteDraft) => void;
};

export function QuickRouteModal(props: QuickRouteModalProps) {
  const handlePick = (
    selection: EndpointModelSelection,
    group: ApiProxyTargetModelGroup | undefined,
  ) => {
    const model = group?.kind === "external-api" ? selection.model : "";
    const suggestion = suggestName(model, group);
    const targetName = props.draft.targetName.trim()
      ? props.draft.targetName
      : suggestion;
    const modelId = props.draft.modelId.trim()
      ? props.draft.modelId
      : suggestion;
    props.onDraftChange({
      ...props.draft,
      endpointId: selection.endpointId,
      model,
      targetName,
      modelId,
    });
  };

  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title="Quick route"
      size="lg"
    >
      <Stack gap="sm">
        <EndpointModelPicker
          value={{
            endpointId: props.draft.endpointId,
            model: props.draft.model,
          }}
          modelDescription="Creates a proxy target for this model and a published model routed to it, all with default settings."
          onChange={handlePick}
        />
        <TextInput
          label="Target name"
          value={props.draft.targetName}
          onChange={(event) => {
            const targetName = event.currentTarget.value;
            props.onDraftChange({ ...props.draft, targetName });
          }}
        />
        <TextInput
          label="Model ID"
          placeholder="Public model id for /v1/models"
          value={props.draft.modelId}
          onChange={(event) => {
            const modelId = event.currentTarget.value;
            props.onDraftChange({ ...props.draft, modelId });
          }}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            leftSection={<Save size={16} />}
            loading={props.busy}
            disabled={
              !props.draft.endpointId ||
              !props.draft.targetName.trim() ||
              !props.draft.modelId.trim()
            }
            onClick={props.onCreate}
          >
            Create route
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
