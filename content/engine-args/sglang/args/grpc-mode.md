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

`--grpc-mode` остался как совместимость: он ничего не делает сам, а при резолве аргументов (`ServerArgs.resolve_once`, шаг `handle_deprecated_args`) превращается в эффективное `smg_grpc_mode=True`. Важно понимать, что включение любого из этих двух флагов **отключает HTTP-сервер целиком** — вместе с `/health`, `/v1/models` и всеми OpenAI-эндпоинтами.

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
- Эффективное значение: шаг резолва `handle_deprecated_args` (`python/sglang/srt/arg_groups/serving_hook.py`) декларирует `smg_grpc_mode=True` и печатает предупреждение. Само поле `grpc_mode` при этом **не сбрасывается** и продолжает участвовать в проверках вида `legacy_grpc = cfg.smg_grpc_mode or cfg.grpc_mode`
- Где объявлен: `python/sglang/srt/arg_groups/fields/serving.py:Serving.grpc_mode`
- Статус: устаревший. Обратите внимание: в extract у него `action: null` — это обычное поле датакласса, а не `Deprecated*Action`; предупреждение печатает шаг резолва `handle_deprecated_args`, а не argparse. Замена — `--smg-grpc-mode`
- Этап применения: `ServerArgs.resolve_once` (из `launch_server.run_server`) → `run_resolution_pipeline`, шаг `handle_deprecated_args` (перенос значения) → выбор точки входа в `run_server`

## Что меняет в движке

`handle_deprecated_args` (`python/sglang/srt/arg_groups/serving_hook.py`):

```python
if cfg.grpc_mode and not cfg.smg_grpc_mode:
    logger.warning(
        "--grpc-mode is deprecated and will be removed in a future "
        "version. Use --smg-grpc-mode for the legacy SMG gRPC server, "
        "or --grpc-port for the native gRPC server."
    )
    declare_resolution(
        server_args,
        "_handle_deprecated_args",
        smg_grpc_mode=True,
    )
```

Сырое `server_args.smg_grpc_mode` остается `False`; `True` — это эффективное значение, которое видно через `resolving_view()` / `resolved_dict()`.

Дальше значение участвует в трех местах:

1. `legacy_grpc = cfg.smg_grpc_mode or cfg.grpc_mode` — если legacy-режим активен и `--grpc-port` не задан, порт выводится как `--port + 10000`.
2. `native_grpc = cfg.grpc_port is not None and not legacy_grpc` — legacy имеет приоритет над нативным сервером, поэтому выведенный в пункте 1 порт не включает нативный путь.
3. `run_server` (`sglang/python/sglang/launch_server.py`) после `resolve_once` выбирает точку входа по эффективным значениям (`resolving_view`): при `smg_grpc_mode` — `serve_grpc` из `sglang.srt.entrypoints.grpc_server`; при `encoder_only` вместе с любым из двух флагов — `serve_grpc_encoder`.

Вся семантика самого режима описана в документе по `--smg-grpc-mode`; здесь она не дублируется.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — обычный HTTP-режим.
- Комбинация `--grpc-mode --smg-grpc-mode` допустима: предупреждение тогда не печатается (условие `and not cfg.smg_grpc_mode`), поведение то же.
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

- `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/serving_hook.py`
- `sglang/python/sglang/launch_server.py`
- `sglang/python/sglang/srt/entrypoints/grpc_server.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- arriero: `docs/ENGINE_ADAPTERS.md`
