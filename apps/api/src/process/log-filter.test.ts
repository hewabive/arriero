import { strict as assert } from "node:assert";
import test from "node:test";

import {
  filterRoutineProbeLogChunk,
  isRoutineManagerProbeSideEffectLogLine,
  isRoutineManagerProbeRequestLogLine,
} from "./log-filter.js";

const localAddresses = new Set(["127.0.0.1", "::1", "82.38.68.56"]);

test("detects routine local arriero probe request log lines", () => {
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      "srv  log_server_r: done request: GET /slots 82.38.68.56 200",
      localAddresses,
    ),
    true,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      "srv  log_server_r: done request: GET /api-prefix/v1/models 127.0.0.1 200",
      localAddresses,
    ),
    true,
  );
});

test("keeps non-local and non-routine request log lines", () => {
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      "srv  log_server_r: done request: GET /slots 203.0.113.10 200",
      localAddresses,
    ),
    false,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      "srv  log_server_r: done request: POST /v1/chat/completions 127.0.0.1 200",
      localAddresses,
    ),
    false,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      "srv  log_server_r: done request: GET /props 127.0.0.1 500",
      localAddresses,
    ),
    false,
  );
});

test("detects routine uvicorn access log lines from local probes", () => {
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      'INFO:     127.0.0.1:52999 - "GET /health HTTP/1.1" 200 OK',
      localAddresses,
    ),
    true,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      'INFO:     127.0.0.1:53000 - "GET /health HTTP/1.1" 503 Service Unavailable',
      localAddresses,
    ),
    true,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      '(APIServer pid=41) INFO:     127.0.0.1:59454 - "GET /v1/models HTTP/1.1" 200 OK',
      localAddresses,
    ),
    true,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      'INFO:     ::1:52999 - "GET /health HTTP/1.1" 200 OK',
      localAddresses,
    ),
    true,
  );
});

test("keeps non-routine uvicorn access log lines", () => {
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      'INFO:     127.0.0.1:52999 - "POST /v1/chat/completions HTTP/1.1" 200 OK',
      localAddresses,
    ),
    false,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      'INFO:     203.0.113.10:52999 - "GET /health HTTP/1.1" 200 OK',
      localAddresses,
    ),
    false,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      'INFO:     127.0.0.1:52999 - "GET /health HTTP/1.1" 500 Internal Server Error',
      localAddresses,
    ),
    false,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      "INFO:     Application startup complete.",
      localAddresses,
    ),
    false,
  );
});

test("filters only complete routine request lines from chunks", () => {
  const chunk = [
    "main: loading model",
    "srv  log_server_r: done request: GET /health 127.0.0.1 503",
    "0.17.466.965 I srv  proxy_reques: proxying request to model Gemma on port 57117",
    "[57117] 0.47.921.945 I srv  update_slots: all slots are idle",
    "srv  log_server_r: done request: POST /v1/chat/completions 127.0.0.1 200",
    "load_tensors: loading model tensors",
  ].join("\n");

  assert.equal(
    filterRoutineProbeLogChunk(`${chunk}\n`, localAddresses),
    [
      "main: loading model",
      "srv  log_server_r: done request: POST /v1/chat/completions 127.0.0.1 200",
      "load_tensors: loading model tensors",
      "",
    ].join("\n"),
  );
});

test("filters routine uvicorn access lines from python engine chunks", () => {
  const chunk = [
    "[2026-08-12 10:41:01] Uvicorn running on http://127.0.0.1:30000 (Press CTRL+C to quit)",
    'INFO:     127.0.0.1:52999 - "GET /health HTTP/1.1" 200 OK',
    '(APIServer pid=41) INFO:     127.0.0.1:59454 - "GET /v1/models HTTP/1.1" 200 OK',
    'INFO:     127.0.0.1:53001 - "POST /v1/chat/completions HTTP/1.1" 200 OK',
  ].join("\n");

  assert.equal(
    filterRoutineProbeLogChunk(`${chunk}\n`, localAddresses),
    [
      "[2026-08-12 10:41:01] Uvicorn running on http://127.0.0.1:30000 (Press CTRL+C to quit)",
      'INFO:     127.0.0.1:53001 - "POST /v1/chat/completions HTTP/1.1" 200 OK',
      "",
    ].join("\n"),
  );
});

test("detects routine router probe side-effect log lines", () => {
  assert.equal(
    isRoutineManagerProbeSideEffectLogLine(
      "0.17.466.965 I srv  proxy_reques: proxying request to model Gemma on port 57117",
    ),
    true,
  );
  assert.equal(
    isRoutineManagerProbeSideEffectLogLine(
      "[57117] 0.47.921.945 I srv  update_slots: all slots are idle",
    ),
    true,
  );
  assert.equal(
    isRoutineManagerProbeSideEffectLogLine(
      "0.17.467.473 E srv    operator(): http client error: Could not establish connection",
    ),
    false,
  );
});

test("does not drop partial request lines without a newline", () => {
  const chunk = "srv  log_server_r: done request: GET /slots 127.0.0.1 200";

  assert.equal(filterRoutineProbeLogChunk(chunk, localAddresses), chunk);
});

test("pino grammar filters healthcheck probes and keeps user requests", () => {
  const probeLine = JSON.stringify({
    level: 30,
    message: "Request completed",
    url: "/healthcheck",
    ip: "127.0.0.1",
    status_code: 200,
  });
  assert.equal(
    isRoutineManagerProbeRequestLogLine(probeLine, localAddresses, "pino"),
    true,
  );
  const userLine = JSON.stringify({
    level: 30,
    message: "Request completed",
    url: "/conversation",
    ip: "127.0.0.1",
    status_code: 200,
  });
  assert.equal(
    isRoutineManagerProbeRequestLogLine(userLine, localAddresses, "pino"),
    false,
  );
  const remoteLine = JSON.stringify({
    level: 30,
    message: "Request completed",
    url: "/healthcheck",
    ip: "203.0.113.10",
    status_code: 200,
  });
  assert.equal(
    isRoutineManagerProbeRequestLogLine(remoteLine, localAddresses, "pino"),
    false,
  );
  assert.equal(
    isRoutineManagerProbeRequestLogLine(
      "No MongoDB URL found, using in-memory server",
      localAddresses,
      "pino",
    ),
    false,
  );
});

test("pino grammar skips the llama side-effect filter", () => {
  const chunk = "I  srv  update_slots: all slots are idle\n";
  assert.equal(
    filterRoutineProbeLogChunk(chunk, localAddresses, "pino"),
    chunk,
  );
  assert.equal(filterRoutineProbeLogChunk(chunk, localAddresses), "");
});
