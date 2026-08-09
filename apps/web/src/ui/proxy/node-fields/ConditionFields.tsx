import { Group, NumberInput, Select, Switch, TextInput } from "@mantine/core";

import type { PipelineNodeDraftOf, PipelineNodeDraftPatch } from "../forms";
import {
  anonymousSourceValue,
  conditionScopeOptions,
  predicateTypeOptions,
  type PipelineEditorContext,
} from "./context";
import { PortSelect } from "./PortSelect";

type ConditionNodeDraft = PipelineNodeDraftOf<"condition">;

export function ConditionFields(props: {
  node: ConditionNodeDraft;
  ctx: PipelineEditorContext;
  update: (patch: PipelineNodeDraftPatch<"condition">) => void;
}) {
  const { node, ctx, update } = props;
  return (
    <>
      <Select
        label="Condition"
        data={predicateTypeOptions}
        value={node.predicateType}
        onChange={(value) =>
          update({
            predicateType: (value ??
              "text-match") as ConditionNodeDraft["predicateType"],
          })
        }
      />
      {node.predicateType === "text-match" && (
        <>
          <Select
            label="Scope"
            data={conditionScopeOptions}
            value={node.scope}
            onChange={(value) =>
              update({
                scope: (value ?? "any-message") as ConditionNodeDraft["scope"],
              })
            }
          />
          <TextInput
            label={node.regex ? "Regex pattern" : "Substring"}
            placeholder={node.regex ? "\\bthink (hard|deeply)\\b" : "text"}
            value={node.pattern}
            onChange={(event) => {
              const pattern = event.currentTarget.value;
              update({ pattern });
            }}
          />
          <Group gap="lg">
            <Switch
              label="Regex"
              checked={node.regex}
              onChange={(event) => {
                const regex = event.currentTarget.checked;
                update({ regex });
              }}
            />
            <Switch
              label="Case sensitive"
              checked={node.caseSensitive}
              onChange={(event) => {
                const caseSensitive = event.currentTarget.checked;
                update({ caseSensitive });
              }}
            />
          </Group>
        </>
      )}
      {node.predicateType === "token-estimate" && (
        <NumberInput
          label="Min tokens (estimated)"
          description="True when the estimated request size is at least this many tokens."
          min={1}
          value={node.minTokens}
          onChange={(value) =>
            update({ minTokens: typeof value === "number" ? value : "" })
          }
        />
      )}
      {node.predicateType === "source" && (
        <Select
          label="Source"
          data={[
            { value: anonymousSourceValue, label: "Anonymous (no key)" },
            ...ctx.sources.map((source) => ({
              value: source.id,
              label: source.name,
            })),
          ]}
          value={node.sourceId || anonymousSourceValue}
          onChange={(value) =>
            update({
              sourceId: !value || value === anonymousSourceValue ? "" : value,
            })
          }
        />
      )}
      <PortSelect
        label="True →"
        ctx={ctx}
        excludeNodeId={node.id}
        value={node.portTrue}
        onChange={(portTrue) => update({ portTrue })}
      />
      <PortSelect
        label="False →"
        ctx={ctx}
        excludeNodeId={node.id}
        value={node.portFalse}
        onChange={(portFalse) => update({ portFalse })}
      />
    </>
  );
}
