import type {
  EnvironmentCreate,
  EnvironmentEngine,
  PackageIndexVersion,
  UvToolStatus,
} from "@arriero/core";
import { packageIndexInstallOptions } from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Collapse,
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

const PUBLIC_INDEX_URL = "https://pypi.org/simple";

type IndexChoice = "public" | "custom";
type DependencySource = "same" | "public" | "custom";
type PythonProvisioning = "download-if-missing" | "require-existing" | "mirror";

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
  running,
  submitting,
  onSubmit,
}: {
  uv: UvToolStatus | undefined;
  running: boolean;
  submitting: boolean;
  onSubmit: (input: EnvironmentCreate) => void;
}) {
  const [engine, setEngine] = useState<EnvironmentEngine>("vllm");
  const [pythonVersion, setPythonVersion] = useState("3.12");
  const [variant, setVariant] = useState<"cuda" | "cpu" | "rocm">("cuda");
  const [sourceKind, setSourceKind] = useState<"pypi" | "wheel">("pypi");
  const [indexChoice, setIndexChoice] = useState<IndexChoice>("public");
  const [indexUrl, setIndexUrl] = useState("");
  const [dependencySource, setDependencySource] =
    useState<DependencySource>("same");
  const [dependencyIndexUrl, setDependencyIndexUrl] = useState("");
  const [version, setVersion] = useState("");
  const [showPreReleases, setShowPreReleases] = useState(false);
  const [extras, setExtras] = useState("");
  const [wheelUrl, setWheelUrl] = useState("");
  const [wheelSha256, setWheelSha256] = useState("");
  const [sglangWheelUrl, setSglangWheelUrl] = useState("");
  const [sglangWheelSha256, setSglangWheelSha256] = useState("");
  const [torchBackend, setTorchBackend] = useState("");
  const [pythonProvisioning, setPythonProvisioning] =
    useState<PythonProvisioning>("download-if-missing");
  const [pythonMirrorUrl, setPythonMirrorUrl] = useState("");
  const [runtimeOpen, setRuntimeOpen] = useState(false);

  const rootIndexUrl =
    indexChoice === "custom" ? indexUrl.trim() || null : null;
  const effectiveDependencyIndexUrl =
    indexChoice === "public"
      ? null
      : dependencySource === "public"
        ? PUBLIC_INDEX_URL
        : dependencySource === "custom"
          ? dependencyIndexUrl.trim() || null
          : null;

  const [debouncedIndexUrl] = useDebouncedValue(rootIndexUrl, 600);
  const [debouncedPythonVersion] = useDebouncedValue(pythonVersion.trim(), 400);

  const versionsQuery = useQuery({
    queryKey: [
      "environment-index-versions",
      engine,
      debouncedIndexUrl,
      debouncedPythonVersion,
    ],
    queryFn: () =>
      listEnvironmentIndexVersions(
        engine,
        debouncedIndexUrl,
        debouncedPythonVersion,
      ),
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
      pythonProvisioning,
      pythonMirrorUrl:
        pythonProvisioning === "mirror" ? pythonMirrorUrl.trim() || null : null,
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
                indexUrl: rootIndexUrl,
                dependencyIndexUrl: effectiveDependencyIndexUrl,
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
                dependencyIndexUrl: effectiveDependencyIndexUrl,
                torchBackend: torchBackend.trim() || null,
              },
      };
    }
    return {
      ...common,
      engine,
      variant,
      pythonVersion: pythonVersion.trim(),
      source:
        sourceKind === "pypi"
          ? {
              kind: "pypi",
              extras: extras
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
              indexUrl: rootIndexUrl,
              dependencyIndexUrl: effectiveDependencyIndexUrl,
            }
          : {
              kind: "wheel",
              url: wheelUrl.trim(),
              sha256: wheelSha256.trim() || null,
              dependencyIndexUrl: effectiveDependencyIndexUrl,
              torchBackend: torchBackend.trim() || null,
            },
    };
  }, [
    engine,
    version,
    variant,
    pythonVersion,
    pythonProvisioning,
    pythonMirrorUrl,
    sourceKind,
    extras,
    rootIndexUrl,
    effectiveDependencyIndexUrl,
    wheelUrl,
    wheelSha256,
    sglangWheelUrl,
    sglangWheelSha256,
    torchBackend,
  ]);

  const plannedCommand = useMemo(() => {
    const options = packageIndexInstallOptions({
      indexUrl: sourceKind === "pypi" ? rootIndexUrl : null,
      dependencyIndexUrl: effectiveDependencyIndexUrl,
    });
    if (torchBackend.trim() && sourceKind === "wheel") {
      options.push("--torch-backend", torchBackend.trim());
    }
    const pin = version.trim() || "<version>";
    const roots =
      sourceKind === "wheel"
        ? [wheelUrl.trim() || "<wheel url>"]
        : engine === "vllm"
          ? [
              `vllm${
                extras.trim()
                  ? `[${extras
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean)
                      .join(",")}]`
                  : ""
              }==${pin}`,
            ]
          : [`kt-kernel==${pin}`, `sglang-kt==${pin}`];
    return ["uv pip install", ...options, ...roots].join(" ");
  }, [
    effectiveDependencyIndexUrl,
    rootIndexUrl,
    torchBackend,
    sourceKind,
    version,
    engine,
    extras,
    wheelUrl,
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
    (sourceKind === "pypi" || Boolean(wheelUrl.trim())) &&
    (indexChoice === "public" || Boolean(indexUrl.trim())) &&
    (pythonProvisioning !== "mirror" || Boolean(pythonMirrorUrl.trim()));

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="md">
        <Text fw={600}>Create immutable environment</Text>
        <Badge color={uv?.available ? "green" : "red"} variant="light">
          {uv?.available ? (uv.version ?? "uv available") : "uv unavailable"}
        </Badge>
      </Group>

      <Stack gap="lg">
        <Stack gap="xs">
          {sectionHeading(1, "What to build")}
          <SegmentedControl
            fullWidth
            value={engine}
            onChange={(value) => {
              const next = value as EnvironmentEngine;
              setEngine(next);
              setVersion("");
              if (next === "ktransformers") {
                setVariant("cuda");
                if (!["3.11", "3.12"].includes(pythonVersion)) {
                  setPythonVersion("3.12");
                }
              }
            }}
            data={[
              { label: "vLLM", value: "vllm" },
              { label: "KTransformers (SGLang-KT)", value: "ktransformers" },
            ]}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label="Python version"
              required
              value={pythonVersion}
              onChange={(event) => setPythonVersion(event.currentTarget.value)}
            />
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Accelerator variant
              </Text>
              {engine === "vllm" ? (
                <SegmentedControl
                  value={variant}
                  onChange={(value) =>
                    setVariant(value as "cuda" | "cpu" | "rocm")
                  }
                  data={[
                    { label: "CUDA", value: "cuda" },
                    { label: "CPU", value: "cpu" },
                    { label: "ROCm", value: "rocm" },
                  ]}
                />
              ) : (
                <Badge variant="light">CUDA</Badge>
              )}
            </Stack>
          </SimpleGrid>
          {engine === "ktransformers" && (
            <Text size="xs" c="dimmed">
              KTransformers requires Linux x86-64, Python 3.11/3.12, and an
              NVIDIA CUDA GPU. kt-kernel and sglang-kt are installed at this
              exact shared version.
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
            <Stack gap="sm">
              <SegmentedControl
                value={indexChoice}
                onChange={(value) => {
                  setIndexChoice(value as IndexChoice);
                  if (value === "public") setDependencySource("same");
                }}
                data={[
                  { label: "Public PyPI", value: "public" },
                  { label: "Custom index", value: "custom" },
                ]}
              />
              {indexChoice === "custom" && (
                <>
                  <TextInput
                    label="Index URL"
                    required
                    description="Holds the root package; must be the Simple API root, usually ending in /simple. Credentials are rejected — private registries authenticate through the manager environment."
                    placeholder="https://gitea.example.com/api/packages/team/pypi/simple"
                    value={indexUrl}
                    onChange={(event) => setIndexUrl(event.currentTarget.value)}
                  />
                  <Stack gap={4}>
                    <Text size="sm" fw={500}>
                      Dependencies resolve from
                    </Text>
                    <SegmentedControl
                      value={dependencySource}
                      onChange={(value) =>
                        setDependencySource(value as DependencySource)
                      }
                      data={[
                        { label: "The same index", value: "same" },
                        { label: "Public PyPI", value: "public" },
                        { label: "Another index", value: "custom" },
                      ]}
                    />
                    <Text size="xs" c="dimmed">
                      A registry that only holds the engine package cannot
                      resolve torch and its peers. Keep &ldquo;the same
                      index&rdquo; only for a closed network that mirrors
                      everything.
                    </Text>
                  </Stack>
                  {dependencySource === "custom" && (
                    <TextInput
                      label="Dependency index URL"
                      required
                      value={dependencyIndexUrl}
                      onChange={(event) =>
                        setDependencyIndexUrl(event.currentTarget.value)
                      }
                    />
                  )}
                </>
              )}
            </Stack>
          ) : (
            <Stack gap="sm">
              <TextInput
                label={engine === "vllm" ? "Wheel URL" : "kt-kernel wheel URL"}
                required
                value={wheelUrl}
                onChange={(event) => setWheelUrl(event.currentTarget.value)}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput
                  label={engine === "vllm" ? "SHA-256" : "kt-kernel SHA-256"}
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
              {engine === "ktransformers" && (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label="sglang-kt wheel URL"
                    required
                    value={sglangWheelUrl}
                    onChange={(event) =>
                      setSglangWheelUrl(event.currentTarget.value)
                    }
                  />
                  <TextInput
                    label="sglang-kt SHA-256"
                    value={sglangWheelSha256}
                    onChange={(event) =>
                      setSglangWheelSha256(event.currentTarget.value)
                    }
                  />
                </SimpleGrid>
              )}
              <TextInput
                label="Dependency index URL"
                description="Use the closed-network index for wheel dependencies"
                value={dependencyIndexUrl}
                onChange={(event) => {
                  setDependencySource("custom");
                  setDependencyIndexUrl(event.currentTarget.value);
                }}
              />
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
                engine === "vllm" ? "vLLM version" : "Matched pair version"
              }
              required
              data={versionOptions}
              filter={substringOptionsFilter}
              limit={40}
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
              placeholder={engine === "vllm" ? "0.26.0" : "0.6.3.post1"}
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
          {engine === "vllm" && sourceKind === "pypi" && (
            <TextInput
              label="Extras"
              description="Comma-separated"
              value={extras}
              onChange={(event) => setExtras(event.currentTarget.value)}
            />
          )}
        </Stack>

        <Stack gap="xs">
          <Group gap="xs">
            {sectionHeading(4, "Python runtime")}
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setRuntimeOpen((open) => !open)}
            >
              {runtimeOpen ? "Hide" : "Show"}
            </Button>
            {pythonProvisioning !== "download-if-missing" && (
              <Badge size="sm" variant="light" color="orange">
                {pythonProvisioning}
              </Badge>
            )}
          </Group>
          <Collapse in={runtimeOpen}>
            <Stack gap="sm">
              <SegmentedControl
                fullWidth
                value={pythonProvisioning}
                onChange={(value) =>
                  setPythonProvisioning(value as PythonProvisioning)
                }
                data={[
                  {
                    label: "Download if missing",
                    value: "download-if-missing",
                  },
                  { label: "Require existing", value: "require-existing" },
                  { label: "Mirror", value: "mirror" },
                ]}
              />
              {pythonProvisioning === "mirror" && (
                <TextInput
                  label="Python runtime mirror URL"
                  required
                  description="An airgap bundle python-runtime-mirror directory, as a file, HTTP or HTTPS URL"
                  placeholder="file:///media/airgap-bundle/python-runtime-mirror"
                  value={pythonMirrorUrl}
                  onChange={(event) =>
                    setPythonMirrorUrl(event.currentTarget.value)
                  }
                />
              )}
              <Text size="xs" c="dimmed">
                {pythonProvisioning === "download-if-missing"
                  ? "uv downloads the interpreter when it is not already managed."
                  : pythonProvisioning === "require-existing"
                    ? "Installation fails before any download if the interpreter is not already managed by uv."
                    : "uv installs the interpreter from the mirror. Every package URL must then be non-public."}
              </Text>
            </Stack>
          </Collapse>
        </Stack>

        <Stack gap="xs">
          {sectionHeading(5, "Review")}
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
