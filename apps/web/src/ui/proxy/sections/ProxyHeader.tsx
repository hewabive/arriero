import { Badge, Button, Group, Paper } from "@mantine/core";
import { Plus, Zap } from "lucide-react";
import { countLabel } from "../../utils/plural";

type ProxyHeaderProps = {
  modelsCount: number;
  pipelinesCount: number;
  targetsCount: number;
  onQuickRoute: () => void;
  onAddModel: () => void;
  onAddPipeline: () => void;
  onAddTarget: () => void;
};

export function ProxyHeader(props: ProxyHeaderProps) {
  return (
    <Paper withBorder p="md" radius="sm">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Group gap="xs" wrap="wrap">
          <Badge variant="light">
            {countLabel(props.modelsCount, "model")}
          </Badge>
          <Badge variant="light">
            {countLabel(props.pipelinesCount, "pipeline")}
          </Badge>
          <Badge variant="light">
            {countLabel(props.targetsCount, "target")}
          </Badge>
          <Badge color="gray" variant="outline">
            guarded forwarding
          </Badge>
        </Group>
        <Group gap="xs" wrap="wrap">
          <Button leftSection={<Zap size={16} />} onClick={props.onQuickRoute}>
            Quick route
          </Button>
          <Button
            variant="light"
            leftSection={<Plus size={16} />}
            onClick={props.onAddModel}
          >
            Add model
          </Button>
          <Button
            variant="light"
            leftSection={<Plus size={16} />}
            onClick={props.onAddPipeline}
          >
            Add pipeline
          </Button>
          <Button
            variant="light"
            leftSection={<Plus size={16} />}
            onClick={props.onAddTarget}
          >
            Add target
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}
