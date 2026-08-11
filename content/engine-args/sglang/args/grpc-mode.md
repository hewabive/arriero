---
schema: 1
engine: sglang
primaryName: "--grpc-mode"
title: "--grpc-mode"
summary: Устаревший псевдоним `--smg-grpc-mode`: включает legacy SMG gRPC-сервер вместо HTTP. При старте печатается предупреждение и значение переносится в `smg_grpc_mode`. В новых конфигурациях не используйте.
group: serving
related:
  - --smg-grpc-mode
  - --grpc-port
  - --smg-http-sidecar-port
  - --sidecar
  - --port
---

# --grpc-mode

## Кратко

Исторически `--grpc-mode` означал «поднять gRPC-сервер вместо HTTP». Затем в SGLang появилось два разных gRPC-сервера — legacy SMG и нативный Rust'овый, — и флаг переименовали: legacy теперь `--smg-grpc-mode`, нативный включается портом `--grpc-port`.

`--grpc-mode` остался как совместимость: он ничего не делает сам, а переписывается в `smg_grpc_mode` на этапе `__post_init__`. Важно понимать, что включение любого из этих двух флагов **отключает HTTP-сервер целиком** — вместе с `/health`, `/v1/models` и всеми OpenAI-эндпоинтами.

## Оригинальная справка

```text
(Deprecated, use --smg-grpc-mode) Legacy SMG gRPC server selector.
```

## Паспорт аргумента

- Флаги: `--grpc-mode`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `_handle_deprecated_args` переносит `True` в `smg_grpc_mode` и печатает предупреждение. Само поле `grpc_mode` при этом **не сбрасывается** и продолжает участвовать в проверках вида `legacy_grpc = self.smg_grpc_mode or self.grpc_mode`
- Где объявлен: `ServerArgs.grpc_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: устаревший. Обратите внимание: в extract у него `action: null` — это обычное поле датакласса, а не `Deprecated*Action`; предупреждение печатает `__post_init__`, а не argparse. Замена — `--smg-grpc-mode`
- Этап применения: `__post_init__` (перенос значения) → выбор точки входа в `run_server`

## Что меняет в движке

`_handle_deprecated_args` (`sglang/python/sglang/srt/server_args.py`):

```python
if self.grpc_mode and not self.smg_grpc_mode:
    logger.warning(
        "--grpc-mode is deprecated and will be removed in a future "
        "version. Use --smg-grpc-mode for the legacy SMG gRPC server, "
        "or --grpc-port for the native gRPC server."
    )
    self.smg_grpc_mode = True
```

Дальше значение участвует в трех местах:

1. `legacy_grpc = self.smg_grpc_mode or self.grpc_mode` — если legacy-режим активен и `--grpc-port` не задан, порт выводится как `--port + 10000`.
2. `native_grpc = self.grpc_port is not None and not legacy_grpc` — legacy имеет приоритет над нативным сервером, поэтому повторные прогоны `__post_init__` идемпотентны.
3. `run_server` (`sglang/python/sglang/launch_server.py`) выбирает точку входа: при `smg_grpc_mode` — `serve_grpc` из `sglang.srt.entrypoints.grpc_server`; при `encoder_only` вместе с любым из двух флагов — `serve_grpc_encoder`.

Вся семантика самого режима описана в документе по `--smg-grpc-mode`; здесь она не дублируется.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — обычный HTTP-режим.
- Комбинация `--grpc-mode --smg-grpc-mode` допустима: предупреждение тогда не печатается (условие `and not self.smg_grpc_mode`), поведение то же.
- Отменить режим после включения нельзя: парного `--no-grpc-mode` нет.

## Когда использовать

- Только в существующих скриптах запуска, которые ещё не переписаны. В любом новом запуске — `--smg-grpc-mode` для legacy SMG или `--grpc-port` для нативного gRPC рядом с HTTP.
- **Не используйте**, если хотите нативный gRPC: этот флаг включает совсем другой сервер и при этом гасит HTTP.

## Влияние на производительность и память

Собственного влияния нет — это переключатель точки входа. Косвенно: legacy-режим не поднимает FastAPI/uvicorn, поэтому чуть экономит RAM хоста и не занимает `--port`.

## Взаимодействие с другими аргументами

- `--smg-grpc-mode`: актуальная форма; этот флаг просто выставляет её.
- `--grpc-port`: в legacy-режиме означает **порт SMG-сервера** и по умолчанию равен `--port + 10000`; нативный сервер при этом не запускается.
- `--smg-http-sidecar-port`: в legacy-режиме поднимается вспомогательный HTTP-сервер с `/metrics` и профилировкой, по умолчанию `--port + 1`.
- `--sidecar`: явно несовместим — `ValueError: --sidecar requires SGLang's native gRPC server; it cannot be combined with --smg-grpc-mode/--grpc-mode.`
- `--port`: в legacy-режиме HTTP на нем не слушается; порт используется только как база для производных портов.

В arriero инстанс kind `ktransformers` пробуется по HTTP: `openai-http`-проба ходит на `/health` и `/v1/models` (`apps/api/src/process/engine-probe.ts`). В legacy gRPC-режиме этих эндпоинтов нет, поэтому инстанс останется без здоровья, а прокси не сможет им пользоваться. Для arriero этот флаг практически неприменим.

## Типовые проблемы и диагностика

- Предупреждение при старте `--grpc-mode is deprecated and will be removed in a future version…` — замените флаг на `--smg-grpc-mode`.
- **Сервер поднялся, но HTTP-порт не отвечает** — это и есть режим: HTTP-сервера нет.
- `ModuleNotFoundError` про `smg-grpc-servicer` — legacy-сервер вынесен в отдельный пакет; он должен быть установлен в окружении.
- **Ожидали нативный gRPC рядом с HTTP** — нужен `--grpc-port` **без** этого флага.
- Принятое значение — в дампе `server_args=` при старте (видны оба поля: `grpc_mode` и уже выставленный `smg_grpc_mode`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --smg-grpc-mode --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --grpc-port 40000 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/launch_server.py`
- `sglang/python/sglang/srt/entrypoints/grpc_server.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- arriero: `docs/ENGINE_ADAPTERS.md`
