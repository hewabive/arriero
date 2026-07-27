import type { LlamaArgumentDocsSyncReport } from "@arriero/core";
import { Alert, Anchor, Code, Stack, Text } from "@mantine/core";
import { AlertTriangle } from "lucide-react";

export function SourceSyncPanel(props: {
  report: LlamaArgumentDocsSyncReport | undefined;
  error: Error | null;
}) {
  const report = props.report;
  const helpChanged = report?.helpSource.inSync === false;

  if (props.error) {
    return (
      <Alert color="red" icon={<AlertTriangle size={16} />} variant="light">
        Не удалось проверить актуальность справки по аргументам:{" "}
        {props.error.message}
      </Alert>
    );
  }

  if (!report) {
    return null;
  }

  const sourceUnavailable =
    Boolean(report.source.error) ||
    !report.source.exists ||
    !report.source.isGitRepo;
  const helpUnavailable =
    report.helpSource.inSync === null ||
    Boolean(report.helpSource.current.error) ||
    Boolean(report.helpSource.stored.error);
  const sourceDirty = report.source.dirty === true;

  if (!sourceUnavailable && !helpUnavailable && !helpChanged && !sourceDirty) {
    return null;
  }

  return (
    <Stack gap="xs">
      {sourceUnavailable && (
        <Alert color="red" icon={<AlertTriangle size={16} />} variant="light">
          Не удалось проверить актуальность справки по аргументам. Если список
          аргументов выглядит неверно, проверьте путь к llama.cpp в настройках и
          сверяйте спорные параметры через <Code>llama-server --help</Code>{" "}
          текущего бинарника.
          {report.source.error && (
            <Text mt={4} size="sm">
              {report.source.error}
            </Text>
          )}
        </Alert>
      )}

      {helpUnavailable && (
        <Alert color="red" icon={<AlertTriangle size={16} />} variant="light">
          Не удалось сравнить сохраненный справочник аргументов с текущим
          llama.cpp. Если вы видите странное описание аргумента, сверяйте его
          через <Code>llama-server --help</Code> текущего бинарника.
          {(report.helpSource.current.error ||
            report.helpSource.stored.error) && (
            <Text mt={4} size="sm">
              {report.helpSource.current.error ??
                report.helpSource.stored.error}
            </Text>
          )}
        </Alert>
      )}

      {helpChanged && !helpUnavailable && (
        <Alert
          color="yellow"
          icon={<AlertTriangle size={16} />}
          variant="light"
        >
          <Text size="sm">
            Справка по аргументам не соответствует текущей версии llama.cpp.
            Подробный diff — на странице{" "}
            <Anchor href="#/source-sync">Source Sync</Anchor>.
          </Text>
        </Alert>
      )}

      {sourceDirty && !sourceUnavailable && (
        <Alert
          color="yellow"
          icon={<AlertTriangle size={16} />}
          variant="light"
        >
          Проверка справки использует локально измененный checkout llama.cpp.
          Если изменения не ваши или описание аргументов выглядит неожиданно,
          дождитесь завершения обновления и перезагрузите страницу.
        </Alert>
      )}
    </Stack>
  );
}
