import type {
  EnvironmentCreate,
  EnvironmentEngine,
  EnvironmentRepositorySettings,
  EnvironmentVariant,
  PackageIndexVersion,
  UvToolStatus,
} from "@arriero/core";
import {
  ENVIRONMENT_DEFAULT_PYTHON_VERSION,
  ENVIRONMENT_VARIANT_LABELS,
  EnvironmentEngineSchema,
  environmentDescriptor,
  environmentPypiRequirements,
  packageIndexInstallOptions,
} from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { listEnvironmentIndexVersions } from "../../api/client";
import { substringOptionsFilter, TouchAutocomplete } from "./TouchCombobox";
import { countLabel } from "../utils/plural";

const CREATE_ENGINE_OPTIONS = EnvironmentEngineSchema.options.flatMap(
  (option) => {
    const create = environmentDescriptor(option).create;
    return create ? [{ value: option, label: create.label }] : [];
  },
);

function sectionHeading(step: number, title: string, hint?: string) {
  return (
    <Group gap="xs" align="baseline">
      <Badge size="sm" variant="light" circle>
        {step}
      </Badge>
      <Text fw={600}>{title}</Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Group>
  );
}

function versionAnnotation(entry: PackageIndexVersion) {
  const parts: string[] = [];
  if (entry.missingDistributions.length) {
    parts.push(`missing ${entry.missingDistributions.join(", ")}`);
  }
  if (entry.requiresPython)
    parts.push(`requires-python ${entry.requiresPython}`);
  parts.push(
    `${entry.files.length} file${entry.files.length === 1 ? "" : "s"}`,
  );
  return parts.join(" · ");
}

export function EnvironmentCreateForm({
  uv,
  repositories,
  running,
  submitting,
  onSubmit,
}: {
  uv: UvToolStatus | undefined;
  repositories: EnvironmentRepositorySettings;
  running: boolean;
  submitting: boolean;
  onSubmit: (input: EnvironmentCreate) => void;
}) {
  const [engine, setEngine] =
    useState<Exclude<EnvironmentEngine, "chat-ui">>("vllm");
  const [pythonVersion, setPythonVersion] = useState(
    ENVIRONMENT_DEFAULT_PYTHON_VERSION,
  );
  const [variant, setVariant] = useState<EnvironmentVariant>("cuda");
  const [sourceKind, setSourceKind] = useState<"pypi" | "wheel">("pypi");
  const [version, setVersion] = useState("");
  const [showPreReleases, setShowPreReleases] = useState(false);
  const [extras, setExtras] = useState("");
  const [wheelUrl, setWheelUrl] = useState("");
  const [wheelSha256, setWheelSha256] = useState("");
  const [sglangWheelUrl, setSglangWheelUrl] = useState("");
  const [sglangWheelSha256, setSglangWheelSha256] = useState("");
  const [torchBackend, setTorchBackend] = useState("");
  const [debouncedPythonVersion] = useDebouncedValue(pythonVersion.trim(), 400);

  const descriptor = environmentDescriptor(engine);
  const createFacts = descriptor.create;
  const distributionPair =
    descriptor.distributions.length > 1
      ? {
          primary: descriptor.distributions[0] ?? "",
          secondary: descriptor.distributions[1] ?? "",
        }
      : null;

  const versionsQuery = useQuery({
    queryKey: [
      "environment-index-versions",
      engine,
      repositories.packageIndexUrl,
      debouncedPythonVersion,
    ],
    queryFn: () => listEnvironmentIndexVersions(engine, debouncedPythonVersion),
    enabled: sourceKind === "pypi",
    staleTime: 120_000,
  });
  const lookup = versionsQuery.data?.data;

  const visibleVersions = useMemo(() => {
    const versions = lookup?.versions ?? [];
    return showPreReleases
      ? versions
      : versions.filter((entry) => !entry.preRelease);
  }, [lookup, showPreReleases]);

  const versionOptions = useMemo(
    () =>
      visibleVersions.map((entry) => ({
        value: entry.version,
        label: entry.version,
        disabled: entry.missingDistributions.length > 0,
      })),
    [visibleVersions],
  );

  const versionByValue = useMemo(
    () => new Map(visibleVersions.map((entry) => [entry.version, entry])),
    [visibleVersions],
  );

  const selectedVersion = visibleVersions.find(
    (entry) => entry.version === version.trim(),
  );
  const unknownVersion = Boolean(
    version.trim() && lookup?.status === "ok" && !selectedVersion,
  );

  const createInput = useMemo<EnvironmentCreate>(() => {
    const common = {
      version: version.trim(),
    };
    if (engine === "ktransformers") {
      return {
        ...common,
        engine,
        variant: "cuda",
        pythonVersion: pythonVersion.trim() as "3.11" | "3.12",
        source:
          sourceKind === "pypi"
            ? {
                kind: "pypi",
              }
            : {
                kind: "wheels",
                artifacts: [
                  {
                    distribution: "kt-kernel",
                    url: wheelUrl.trim(),
                    sha256: wheelSha256.trim() || null,
                  },
                  {
                    distribution: "sglang-kt",
                    url: sglangWheelUrl.trim(),
                    sha256: sglangWheelSha256.trim() || null,
                  },
                ],
                torchBackend: torchBackend.trim() || null,
              },
      };
    }
    const singleWheelSource =
      sourceKind === "pypi"
        ? {
            kind: "pypi" as const,
            extras: extras
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : {
            kind: "wheel" as const,
            url: wheelUrl.trim(),
            sha256: wheelSha256.trim() || null,
            torchBackend: torchBackend.trim() || null,
          };
    if (engine === "sglang") {
      return {
        ...common,
        engine,
        variant: "cuda",
        pythonVersion: pythonVersion.trim(),
        source: singleWheelSource,
      };
    }
    if (engine === "open-webui") {
      return {
        ...common,
        engine,
        variant: "cpu",
        pythonVersion: pythonVersion.trim() as "3.11" | "3.12",
        source: singleWheelSource,
      };
    }
    return {
      ...common,
      engine,
      variant,
      pythonVersion: pythonVersion.trim(),
      source: singleWheelSource,
    };
  }, [
    engine,
    version,
    variant,
    pythonVersion,
    sourceKind,
    extras,
    wheelUrl,
    wheelSha256,
    sglangWheelUrl,
    sglangWheelSha256,
    torchBackend,
  ]);

  const plannedCommand = useMemo(() => {
    const paired = environmentDescriptor(engine).distributions.length > 1;
    const options = packageIndexInstallOptions(repositories.packageIndexUrl);
    if (torchBackend.trim() && sourceKind === "wheel") {
      options.push("--torch-backend", torchBackend.trim());
    }
    const pin = version.trim() || "<version>";
    const extrasList = paired
      ? []
      : extras
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    const roots =
      sourceKind === "wheel"
        ? [
            wheelUrl.trim() || "<wheel url>",
            ...(paired ? [sglangWheelUrl.trim() || "<wheel url>"] : []),
          ]
        : environmentPypiRequirements(engine, pin, extrasList);
    return ["uv pip install", ...options, ...roots].join(" ");
  }, [
    repositories.packageIndexUrl,
    torchBackend,
    sourceKind,
    version,
    engine,
    extras,
    wheelUrl,
    sglangWheelUrl,
  ]);

  const indexStatus = () => {
    if (sourceKind !== "pypi") return null;
    if (versionsQuery.isFetching) {
      return (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Reading the index…
          </Text>
        </Group>
      );
    }
    if (versionsQuery.isError) {
      return (
        <Text size="xs" c="red">
          {(versionsQuery.error as Error).message}
        </Text>
      );
    }
    if (!lookup) return null;
    if (lookup.status === "ok") {
      return (
        <Text size="xs" c="dimmed">
          {lookup.versions.length} version
          {lookup.versions.length === 1 ? "" : "s"} on {lookup.indexUrl}
          {showPreReleases
            ? ""
            : ` · ${countLabel(lookup.versions.length - visibleVersions.length, "pre-release")} hidden`}
        </Text>
      );
    }
    const color = lookup.status === "unreachable" ? "red" : "orange";
    return (
      <Text size="xs" c={color}>
        {lookup.status}: {lookup.message}
      </Text>
    );
  };

  const canSubmit =
    Boolean(uv?.available) &&
    !running &&
    Boolean(version.trim()) &&
    Boolean(pythonVersion.trim()) &&
    (sourceKind === "pypi" ||
      (Boolean(wheelUrl.trim()) &&
        (!distributionPair || Boolean(sglangWheelUrl.trim()))));

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="md">
        <Text fw={600}>Create immutable environment</Text>
        <Badge color={uv?.available ? "green" : "red"} variant="light">
          {uv?.available
            ? (uv.version ?? "uv available")
            : (uv?.reason ?? "uv unavailable")}
        </Badge>
      </Group>

      <Stack gap="lg">
        <Stack gap="xs">
          {sectionHeading(1, "What to build")}
          <SegmentedControl
            fullWidth
            value={engine}
            onChange={(value) => {
              const next = value as Exclude<EnvironmentEngine, "chat-ui">;
              const nextDescriptor = environmentDescriptor(next);
              setEngine(next);
              setVersion("");
              setExtras(nextDescriptor.defaultExtras.join(","));
              if (!nextDescriptor.variants.includes(variant)) {
                setVariant(nextDescriptor.variants[0] ?? "cuda");
              }
              const python = nextDescriptor.python;
              if (python?.versions) {
                const trimmed = pythonVersion.trim();
                setPythonVersion(
                  python.versions.includes(trimmed)
                    ? trimmed
                    : python.defaultVersion,
                );
              }
            }}
            data={CREATE_ENGINE_OPTIONS}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {descriptor.python?.versions ? (
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Python version
                </Text>
                <SegmentedControl
                  value={pythonVersion}
                  onChange={setPythonVersion}
                  data={[...descriptor.python.versions]}
                />
              </Stack>
            ) : (
              <TextInput
                label="Python version"
                required
                value={pythonVersion}
                onChange={(event) =>
                  setPythonVersion(event.currentTarget.value)
                }
              />
            )}
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Accelerator variant
              </Text>
              {descriptor.variants.length > 1 ? (
                <SegmentedControl
                  value={variant}
                  onChange={(value) => setVariant(value as EnvironmentVariant)}
                  data={descriptor.variants.map((option) => ({
                    label: ENVIRONMENT_VARIANT_LABELS[option],
                    value: option,
                  }))}
                />
              ) : (
                <Badge variant="light">
                  {ENVIRONMENT_VARIANT_LABELS[descriptor.variants[0] ?? "cuda"]}
                </Badge>
              )}
            </Stack>
          </SimpleGrid>
          {createFacts?.note && (
            <Text size="xs" c="dimmed">
              {createFacts.note}
            </Text>
          )}
        </Stack>

        <Stack gap="xs">
          {sectionHeading(2, "Where to install from")}
          <SegmentedControl
            fullWidth
            value={sourceKind}
            onChange={(value) => setSourceKind(value as "pypi" | "wheel")}
            data={[
              { label: "Package index", value: "pypi" },
              { label: "Wheel URL", value: "wheel" },
            ]}
          />

          {sourceKind === "pypi" ? (
            <Text size="xs" c="dimmed">
              Root package and dependencies resolve from the configured site
              index: {repositories.packageIndexUrl ?? "public PyPI"}.
            </Text>
          ) : (
            <Stack gap="sm">
              <TextInput
                label={
                  distributionPair
                    ? `${distributionPair.primary} wheel URL`
                    : "Wheel URL"
                }
                required
                value={wheelUrl}
                onChange={(event) => setWheelUrl(event.currentTarget.value)}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput
                  label={
                    distributionPair
                      ? `${distributionPair.primary} SHA-256`
                      : "SHA-256"
                  }
                  value={wheelSha256}
                  onChange={(event) =>
                    setWheelSha256(event.currentTarget.value)
                  }
                />
                <TextInput
                  label="Torch backend"
                  placeholder="cpu"
                  value={torchBackend}
                  onChange={(event) =>
                    setTorchBackend(event.currentTarget.value)
                  }
                />
              </SimpleGrid>
              {distributionPair && (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label={`${distributionPair.secondary} wheel URL`}
                    required
                    value={sglangWheelUrl}
                    onChange={(event) =>
                      setSglangWheelUrl(event.currentTarget.value)
                    }
                  />
                  <TextInput
                    label={`${distributionPair.secondary} SHA-256`}
                    value={sglangWheelSha256}
                    onChange={(event) =>
                      setSglangWheelSha256(event.currentTarget.value)
                    }
                  />
                </SimpleGrid>
              )}
              <Text size="xs" c="dimmed">
                Dependencies resolve from the configured site index:{" "}
                {repositories.packageIndexUrl ?? "public PyPI"}.
              </Text>
            </Stack>
          )}
        </Stack>

        <Stack gap="xs">
          {sectionHeading(
            3,
            "Which release",
            sourceKind === "wheel" ? "the wheel above decides the build" : "",
          )}
          <Group align="flex-end" gap="xs" wrap="nowrap">
            <TouchAutocomplete
              style={{ flex: 1 }}
              label={
                distributionPair
                  ? "Matched pair version"
                  : `${descriptor.displayName} version`
              }
              required
              data={versionOptions}
              filter={substringOptionsFilter}
              limit={40}
              floatingHeight="viewport"
              renderOption={({ option }) => {
                const entry = versionByValue.get(option.value);
                const reason = entry?.missingDistributions.length
                  ? `not published: ${entry.missingDistributions.join(", ")}`
                  : entry?.pythonCompatible === false
                    ? `not for Python ${pythonVersion.trim()}`
                    : null;
                return (
                  <Group
                    justify="space-between"
                    gap="xs"
                    wrap="nowrap"
                    style={{ width: "100%" }}
                  >
                    <Text size="sm">{option.value}</Text>
                    {reason && (
                      <Text size="xs" c="dimmed">
                        {reason}
                      </Text>
                    )}
                  </Group>
                );
              }}
              value={version}
              onChange={setVersion}
              placeholder={createFacts?.versionPlaceholder}
              description={
                sourceKind === "wheel"
                  ? "Must match the version inside the wheel; it is verified after install"
                  : "Pick from the index or type any version; the exact value is verified after install"
              }
            />
            {sourceKind === "pypi" && (
              <Button
                variant="light"
                aria-label="Reload versions"
                loading={versionsQuery.isFetching}
                onClick={() => void versionsQuery.refetch()}
              >
                <RefreshCw size={16} />
              </Button>
            )}
          </Group>
          {indexStatus()}
          {sourceKind === "pypi" && (
            <Switch
              size="xs"
              checked={showPreReleases}
              onChange={(event) =>
                setShowPreReleases(event.currentTarget.checked)
              }
              label="Show pre-releases and dev builds"
            />
          )}
          {selectedVersion && (
            <Text
              size="xs"
              c={
                selectedVersion.pythonCompatible === false ? "orange" : "dimmed"
              }
            >
              {versionAnnotation(selectedVersion)}
              {selectedVersion.pythonCompatible === false &&
                ` — declares no support for Python ${pythonVersion.trim()}`}
            </Text>
          )}
          {unknownVersion && (
            <Text size="xs" c="orange">
              {version.trim()} is not listed on this index; the install will
              fail unless the index is stale or the release is hidden.
            </Text>
          )}
          {!distributionPair && sourceKind === "pypi" && (
            <TextInput
              label="Extras"
              description="Comma-separated"
              value={extras}
              onChange={(event) => setExtras(event.currentTarget.value)}
            />
          )}
        </Stack>

        <Stack gap="xs">
          {sectionHeading(4, "Review")}
          <Text size="xs" c="dimmed">
            Python runtime:{" "}
            {repositories.pythonMirrorUrl ?? "uv public downloads"}
          </Text>
          <Code block>{plannedCommand}</Code>
          <Button
            loading={submitting}
            disabled={!canSubmit}
            onClick={() => onSubmit(createInput)}
          >
            Create environment
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
