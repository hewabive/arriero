import type { BenchmarkScenario } from "@arriero/core";

export type ScheduledBenchmarkRequest = {
  client: number;
  sequence: number;
  repetition: number;
  signal: AbortSignal;
};

export async function runBenchmarkSchedule(input: {
  scenario: BenchmarkScenario;
  clients: number;
  signal: AbortSignal;
  run: (request: ScheduledBenchmarkRequest) => Promise<void>;
}): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let sequence = 0;
  const failures: unknown[] = [];
  const run = async (client: number, repetition: number) => {
    if (signal.aborted) return;
    const index = sequence++;
    try {
      await input.run({ client, sequence: index, repetition, signal });
    } catch (error) {
      if (failures.length === 0) failures.push(error);
      controller.abort();
    }
  };
  const clients = Array.from({ length: input.clients }, (_, index) => index);
  if (input.scenario.mode === "sustained") {
    const limit = input.scenario.totalRequests;
    if (limit === undefined || limit < input.clients) {
      throw new Error("sustained request count must cover every client");
    }
    await Promise.all(
      clients.map(async (client) => {
        while (!signal.aborted && sequence < limit) {
          await run(client, 0);
        }
      }),
    );
  } else {
    for (
      let repetition = 0;
      repetition < input.scenario.repetitions && !signal.aborted;
      repetition += 1
    ) {
      if (input.scenario.mode === "parallel") {
        await Promise.all(clients.map((client) => run(client, repetition)));
      } else {
        for (const client of clients) {
          if (signal.aborted) break;
          await run(client, repetition);
        }
      }
    }
  }
  if (failures.length > 0) throw failures[0];
}
