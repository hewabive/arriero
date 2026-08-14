export type ConfigFileErrorStage = "json" | "schema";

export class ConfigFileError extends Error {
  readonly path: string;
  readonly stage: ConfigFileErrorStage;

  constructor(path: string, stage: ConfigFileErrorStage, detail: string) {
    super(
      stage === "json"
        ? `Invalid JSON in ${path}: ${detail}`
        : `Invalid config in ${path}: ${detail}`,
    );
    this.name = "ConfigFileError";
    this.path = path;
    this.stage = stage;
  }
}
