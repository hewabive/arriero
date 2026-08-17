import type { BuildSettings } from "@arriero/core";
import {
  Badge,
  Box,
  Code,
  Group,
  JsonInput,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";

import { PathPickerInput } from "../components/PathPickerInput";
import { TouchSelect } from "../components/TouchCombobox";
import { BuildSwitch } from "./BuildSwitch";
import {
  type BuildFormState,
  sourceStatusColor,
  sourceStatusLabel,
} from "./build-view-helpers";
import { type BuildViewController } from "./use-build-view";

export function BuildSettingsForm({ fm }: { fm: BuildViewController }) {
  const { sourceStatus, refs } = fm;
  return (
    <>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
        <Stack gap={4}>
          <PathPickerInput
            label="llama.cpp repository"
            mode="directory"
            value={fm.repoPath}
            disabled={!fm.settingsReady || fm.sourceBusy}
            onChange={(value) => fm.setFormField("repoPath", value)}
          />
          {sourceStatus && (
            <Group gap="xs" wrap="wrap">
              <Badge color={sourceStatusColor(sourceStatus)} variant="light">
                {sourceStatusLabel(sourceStatus)}
              </Badge>
              {sourceStatus.branch && (
                <Text c="dimmed" size="xs">
                  {sourceStatus.branch}
                </Text>
              )}
              {sourceStatus.currentCommit && (
                <Code>{sourceStatus.currentCommit.slice(0, 12)}</Code>
              )}
              {sourceStatus.latestTag && (
                <Tooltip
                  label="Tag used to name the built binary in the Path Catalog"
                  withArrow
                >
                  <Badge color="blue" variant="light">
                    tag {sourceStatus.latestTag}
                  </Badge>
                </Tooltip>
              )}
              {sourceStatus.dirty && (
                <Badge color="yellow" variant="outline">
                  dirty
                </Badge>
              )}
              {sourceStatus.error && (
                <Text c="red" size="xs">
                  {sourceStatus.error}
                </Text>
              )}
              {!fm.sourceStatusMatchesForm && (
                <Text c="dimmed" size="xs">
                  Save to update source status.
                </Text>
              )}
            </Group>
          )}
        </Stack>
        <Stack gap={4}>
          <TouchSelect
            label="Git ref"
            placeholder={fm.detachedRef ?? "Detached / unknown"}
            description="Switches the llama.cpp checkout — affects builds and the Arguments page."
            data={
              refs
                ? [
                    ...(refs.branches.length
                      ? [{ group: "Branches", items: refs.branches }]
                      : []),
                    ...(refs.tags.length
                      ? [{ group: "Tags (recent)", items: refs.tags }]
                      : []),
                  ]
                : []
            }
            value={fm.gitRef}
            searchable
            disabled={
              !fm.settingsReady ||
              !fm.sourceStatusMatchesForm ||
              !fm.sourceReady ||
              fm.sourceBusy ||
              fm.dirty ||
              Boolean(fm.runningJob) ||
              fm.checkoutMutation.isPending
            }
            nothingFoundMessage="No matching ref"
            onChange={(value) => {
              if (!value || value === fm.gitRef) {
                return;
              }
              fm.setGitRef(value);
              fm.checkoutMutation.mutate(value);
            }}
          />
          <PathPickerInput
            label="Builds base directory"
            mode="directory"
            value={fm.buildDir}
            disabled={!fm.settingsReady}
            onChange={(value) => fm.setFormField("buildDir", value)}
          />
          <Box mih={32}>
            {fm.effectiveBuildDir && (
              <Text c="dimmed" size="xs" className="text-wrap">
                Build dir: <Code>{fm.effectiveBuildDir}</Code>
              </Text>
            )}
            {fm.dirty ? (
              <Text c="dimmed" size="xs">
                Working tree is dirty — commit or stash to switch refs.
              </Text>
            ) : fm.refIsTag ? (
              <Text c="dimmed" size="xs">
                Tag checked out — git pull is skipped on build.
              </Text>
            ) : fm.refIsLocalBranch && !fm.branchHasUpstream ? (
              <Text c="dimmed" size="xs">
                No upstream — git pull is skipped on build.
              </Text>
            ) : null}
          </Box>
        </Stack>
        <Select
          label="Build type"
          data={["Release", "Debug", "RelWithDebInfo", "MinSizeRel"]}
          value={fm.buildType}
          allowDeselect={false}
          disabled={!fm.settingsReady}
          onChange={(value) => {
            if (value) {
              fm.setFormField("buildType", value as BuildSettings["buildType"]);
            }
          }}
        />
        <TextInput
          label="Target"
          placeholder="all targets"
          description="Leave empty to build everything (cmake --build without --target)."
          value={fm.target}
          disabled={!fm.settingsReady}
          onChange={(event) =>
            fm.setFormField("target", event.currentTarget.value)
          }
        />
        <NumberInput
          label="Parallel jobs"
          placeholder="all cores"
          description="Compiler processes to run at once; empty means every CPU core."
          min={1}
          max={256}
          value={fm.parallelJobs}
          disabled={!fm.settingsReady}
          onChange={(value) =>
            fm.setFormField(
              "parallelJobs",
              typeof value === "number" ? value : "",
            )
          }
        />
        <Textarea
          label="Extra CMake args"
          placeholder="-DGGML_CUDA_FA_ALL_QUANTS=ON"
          minRows={1}
          value={fm.extraCmakeArgs}
          disabled={!fm.settingsReady}
          onChange={(event) =>
            fm.setFormField("extraCmakeArgs", event.currentTarget.value)
          }
        />
        <TextInput
          label="npm registry"
          placeholder="https://registry.npmjs.org/"
          description="Registry npm ci uses during the UI rebuild; leave blank for npm's default. Shared by every npm-based build."
          value={fm.npmRegistryUrl}
          disabled={!fm.settingsReady}
          onChange={(event) => fm.setNpmRegistryUrl(event.currentTarget.value)}
        />
      </SimpleGrid>

      <JsonInput
        label="Build environment"
        description="Applied to git, npm, CMake and compiler processes."
        minRows={3}
        formatOnBlur
        value={fm.buildEnvJson}
        disabled={!fm.settingsReady}
        onChange={(value) => fm.setFormField("buildEnvJson", value)}
        placeholder='{"CUDACXX": "/usr/local/cuda/bin/nvcc"}'
      />

      <Stack gap="xs">
        <Text fw={600} size="sm">
          Build steps
        </Text>
        <Group gap="lg" wrap="wrap">
          <BuildSwitch
            label="Pull updates"
            tooltip="Runs git pull --ff-only in the llama.cpp repository."
            checked={fm.runPull}
            onChange={fm.setRunPull}
          />
          <BuildSwitch
            label="Rebuild UI"
            tooltip="Removes tools/ui/dist, then runs npm ci and npm run build in tools/ui."
            checked={fm.runUiRebuild}
            onChange={fm.setRunUiRebuild}
          />
          <BuildSwitch
            label="Clean build dir"
            tooltip="Deletes the selected build directory before CMake runs."
            checked={fm.runCleanBuildDir}
            onChange={fm.setRunCleanBuildDir}
          />
          <BuildSwitch
            label="Configure CMake"
            tooltip="Runs cmake configure with the selected repository, build directory and CMake options."
            checked={fm.runConfigure}
            onChange={fm.setRunConfigure}
          />
          <BuildSwitch
            label="Build target"
            tooltip="Runs cmake --build for the selected target, or all targets when Target is empty."
            checked={fm.runBuild}
            onChange={fm.setRunBuild}
          />
        </Group>
      </Stack>

      <Stack gap="xs">
        <Text fw={600} size="sm">
          CMake options
        </Text>
        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="sm">
          <Select
            label="Build profile"
            data={[
              { value: "server", label: "Server only" },
              { value: "full", label: "Full upstream" },
            ]}
            value={fm.buildProfile}
            allowDeselect={false}
            disabled={!fm.settingsReady}
            onChange={(value) => {
              if (value) {
                fm.setFormField(
                  "buildProfile",
                  value as BuildSettings["buildProfile"],
                );
              }
            }}
          />
          <Select
            label="CUDA architectures"
            data={[
              { value: "default", label: "Auto" },
              { value: "native", label: "Native GPU" },
              { value: "custom", label: "Custom list" },
            ]}
            value={fm.cudaArchitectureMode}
            allowDeselect={false}
            disabled={!fm.settingsReady || !fm.cuda}
            onChange={(value) => {
              if (value) {
                fm.setFormField(
                  "cudaArchitectureMode",
                  value as BuildFormState["cudaArchitectureMode"],
                );
              }
            }}
          />
          {fm.cudaArchitectureMode === "custom" && (
            <TextInput
              label="CUDA architecture list"
              placeholder="86;89"
              value={fm.cudaArchitectureValue}
              disabled={!fm.settingsReady || !fm.cuda}
              onChange={(event) =>
                fm.setFormField(
                  "cudaArchitectureValue",
                  event.currentTarget.value,
                )
              }
            />
          )}
          <Select
            label="CUDA graphs"
            data={[
              { value: "default", label: "Default" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            value={fm.cudaGraphs}
            allowDeselect={false}
            disabled={!fm.settingsReady || !fm.cuda}
            onChange={(value) => {
              if (value) {
                fm.setFormField(
                  "cudaGraphs",
                  value as BuildSettings["cudaGraphs"],
                );
              }
            }}
          />
          <Select
            label="LLGuidance"
            data={[
              { value: "default", label: "Default" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            value={fm.llguidance}
            allowDeselect={false}
            disabled={!fm.settingsReady}
            onChange={(value) => {
              if (value) {
                fm.setFormField(
                  "llguidance",
                  value as BuildSettings["llguidance"],
                );
              }
            }}
          />
        </SimpleGrid>
        <Group gap="lg" wrap="wrap">
          <BuildSwitch
            label="CUDA backend"
            tooltip="Configures GGML_CUDA=ON and tries to discover nvcc/CUDACXX."
            checked={fm.cuda}
            disabled={!fm.settingsReady}
            onChange={(value) => fm.setFormField("cuda", value)}
          />
          <BuildSwitch
            label="RPC backend"
            tooltip="Configures GGML_RPC=ON and builds the rpc-server worker for distributing a model across several machines."
            checked={fm.rpc}
            disabled={!fm.settingsReady}
            onChange={(value) => fm.setFormField("rpc", value)}
          />
          <BuildSwitch
            label="Native CPU"
            tooltip="Configures GGML_NATIVE=ON; the binary may be optimized for this CPU and less portable."
            checked={fm.native}
            disabled={!fm.settingsReady}
            onChange={(value) => fm.setFormField("native", value)}
          />
          <BuildSwitch
            label="CUDA FA all quants"
            tooltip="Configures GGML_CUDA_FA_ALL_QUANTS=ON; more KV-cache quant choices, longer CUDA compile."
            checked={fm.cudaFaAllQuants}
            disabled={!fm.settingsReady || !fm.cuda}
            onChange={(value) => fm.setFormField("cudaFaAllQuants", value)}
          />
          <BuildSwitch
            label="Disable CUDA VMM"
            tooltip="Configures GGML_CUDA_NO_VMM=ON for CUDA driver or memory mapping compatibility issues."
            checked={fm.cudaNoVmm}
            disabled={!fm.settingsReady || !fm.cuda}
            onChange={(value) => fm.setFormField("cudaNoVmm", value)}
          />
        </Group>
      </Stack>
    </>
  );
}
