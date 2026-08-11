---
schema: 1
engine: vllm
primaryName: "--enable-elastic-ep"
title: "--enable-elastic-ep"
summary: Переводит группы DP/EP на stateless-NCCL, чтобы число data-parallel движков можно было менять на живом сервере через `/scale_elastic_ep`. Обвешан жёсткими ограничениями: только с EPLB, без pipeline parallelism, с одним API-процессом и Ray-backend'ом DP.
group: ParallelConfig
related:
  - --enable-eplb
  - --eplb-config
  - --enable-expert-parallel
  - --data-parallel-size
  - --data-parallel-backend
  - --data-parallel-external-lb
  - --data-parallel-hybrid-lb
  - --pipeline-parallel-size
  - --api-server-count
---

# --enable-elastic-ep

## Кратко

Обычно топология процессов у vLLM фиксируется на старте. `--enable-elastic-ep` меняет способ создания коммуникационных групп на stateless-варианты, после чего число data-parallel движков можно менять у работающего сервера — HTTP-запросом `POST /scale_elastic_ep` с полем `new_data_parallel_size`.

Это молодая и сильно ограниченная возможность. Список запретов проверяется на старте: обязателен `--enable-eplb`, запрещён pipeline parallelism, запрещены внешний и гибридный DP-балансировщики, число API-процессов принудительно опускается до одного, а само масштабирование в рантайме требует `--data-parallel-backend ray`. Кроме того, конфигурация с этим флагом принудительно уходит на Model Runner V1: V2 её не поддерживает.

## Оригинальная справка

```text
Enable elastic expert parallelism with stateless NCCL groups for DP/EP.
```

## Паспорт аргумента

- Флаги: `--enable-elastic-ep`, `--no-enable-elastic-ep`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-elastic-ep` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: сам флаг не переопределяется, но переопределяет соседей — `--api-server-count` принудительно понижается до 1 с предупреждением, `use_v2_model_runner` становится ложным (elastic EP в списке неподдерживаемого V2), автовыбор `eplb_config.communicator` при отсутствии NIXL даёт `pynccl` вместо `torch_gloo`, и пропускается предварительное выделение портов DP-мастера
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.enable_elastic_ep`
- Этап применения: разбор CLI (`vllm/entrypoints/cli/serve.py`) → `ParallelConfig.__post_init__` (валидация) → инициализация распределённого окружения (stateless-группы) → рантайм (`/scale_elastic_ep`)

## Что меняет в движке

**Проверки в `ParallelConfig.__post_init__`:**

- `Elastic EP is only supported with enable_eplb=True.`
- `Elastic EP is not supported with pipeline parallelism (pipeline_parallel_size=N).`
- `Elastic EP is not compatible with data_parallel_external_lb or data_parallel_hybrid_lb. Elastic EP relies on a single API server and core client to coordinate scale up/down.`
- при `eplb_config.use_async` требуется установленный NIXL: `Elastic EP with async EPLB requires the NIXL package. Either install NIXL or set --eplb-config.use_async=false.`

**Коммуникационные группы.** В `vllm/distributed/parallel_state.py` ветвление по `enable_elastic_ep` меняет способ построения групп: обычная схема пересчитывает ранги под DP и берёт единый `distributed_init_method`, а elastic-схема использует stateless-группы и локальные ранги (в частности, DCP-группа строится по `local_all_ranks`, а не по глобальным). Из-за stateless-групп предварительное выделение пяти портов DP-мастера пропускается.

**Один API-процесс.** `vllm/entrypoints/cli/serve.py` при заданном флаге логирует `Elastic EP only supports running with with at most one API server. Capping api_server_count from %d to 1.` и понижает значение.

**Клиент движков.** `enable_input_socket_handover = parallel_config.enable_elastic_ep` — сокеты ввода передаются при пересборке набора движков, иначе масштабирование разорвало бы соединения.

**Масштабирование.** `AsyncLLM.scale_elastic_ep(new_data_parallel_size, drain_timeout)` под блокировкой вызывает `prepare_elastic_ep`, при необходимости дренирует запросы (`VLLM_ELASTIC_EP_DRAIN_REQUESTS`), затем `commit_elastic_ep` и обновляет `data_parallel_size` в конфиге. `prepare_elastic_ep` содержит утверждение `Only ray DP backend supports scaling elastic EP` — то есть без `--data-parallel-backend ray` попытка масштабирования упадёт уже в рантайме, хотя старт пройдёт.

**HTTP-контур.** Маршруты `/scale_elastic_ep` и `/is_scaling_elastic_ep` регистрируются для любой модели с задачей `generate`, независимо от этого флага; вместе с ними ставится `ScalingMiddleware`, которая отклоняет запросы во время перестройки. То есть эндпоинт открыт всегда, а флаг определяет лишь, сможет ли он что-то сделать.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- `--no-enable-elastic-ep` — явное подтверждение дефолта.
- Диапазон масштабирования флагом не задаётся: он приходит в теле запроса `POST /scale_elastic_ep` (`new_data_parallel_size` — положительное целое, `drain_timeout` — положительное целое, по умолчанию 120 секунд).

## Когда использовать

- **Крупное wide-EP развёртывание на Ray**, где нужно добавлять и убирать DP-движки без рестарта сервера.
- **Не берите на одном узле с одним движком.** Все ограничения останутся, а масштабировать будет нечего.
- **Не берите вместе с pipeline parallelism или с внешним DP-балансировщиком** — старт не пройдёт.
- **Считайте возможность экспериментальной.** Она несовместима с Model Runner V2, требует NIXL для асинхронного EPLB и опирается на единственный API-процесс; контракт может измениться между релизами. Проверять наличие флага в конкретной сборке — `vllm serve --help` в нужном окружении.
- **Отдельно оцените периметр.** `/scale_elastic_ep` не аутентифицирован самим vLLM: сервер, доступный не только с localhost, обязан быть за прокси с авторизацией.

## Влияние на производительность и память

- **VRAM.** Флаг сам по себе память не меняет; её меняет фактический `data_parallel_size` после масштабирования и `num_redundant_experts` в EPLB.
- **Model Runner.** Принудительный V1 вместо V2 — это отдельное отличие в производительности, не связанное с масштабированием как таковым.
- **Latency при масштабировании.** Перестройка групп останавливает обслуживание: middleware отклоняет запросы, а при `VLLM_ELASTIC_EP_DRAIN_REQUESTS` сервер ещё и ждёт завершения текущих до `drain_timeout` секунд.
- **API-процессы.** Принудительный `--api-server-count 1` ограничивает пропускную способность HTTP-слоя на больших нагрузках.
- **Время старта.** Существенно не меняется.

## Взаимодействие с другими аргументами

- `--enable-eplb`: обязателен.
- `--enable-expert-parallel`: обязателен транзитивно (его требует EPLB).
- `--eplb-config`: `use_async: true` требует NIXL; автовыбор коммуникатора при отсутствии NIXL даёт `pynccl`.
- `--pipeline-parallel-size`: должен быть 1.
- `--data-parallel-backend`: для реального масштабирования нужен `ray`.
- `--data-parallel-external-lb`, `--data-parallel-hybrid-lb`: запрещены.
- `--api-server-count`: принудительно понижается до 1.
- `--data-parallel-size`: стартовое значение, которое затем меняется запросами.

## Типовые проблемы и диагностика

- **Симптом:** `Elastic EP is only supported with enable_eplb=True.` **Лечение:** добавить `--enable-eplb` (и, значит, `--enable-expert-parallel`).
- **Симптом:** `Elastic EP is not supported with pipeline parallelism (pipeline_parallel_size=2).` **Лечение:** `--pipeline-parallel-size 1`.
- **Симптом:** `Elastic EP is not compatible with data_parallel_external_lb or data_parallel_hybrid_lb.` **Лечение:** убрать соответствующий флаг DP-балансировки.
- **Симптом:** `Elastic EP with async EPLB requires the NIXL package.` **Лечение:** установить NIXL или `--eplb-config.use_async false`.
- **Симптом:** сервер стартовал, но `POST /scale_elastic_ep` возвращает 500, а в логе `Only ray DP backend supports scaling elastic EP`. **Причина:** `--data-parallel-backend` не `ray`. **Лечение:** перезапустить с Ray-backend'ом DP.
- **Симптом:** `POST /scale_elastic_ep` вернул 408 `Scale failed due to request drain timeout after N seconds`. **Причина:** активные запросы не завершились за `drain_timeout`. **Лечение:** увеличить `drain_timeout` в теле запроса.
- **Симптом:** `Elastic EP scaling is already prepared`. **Причина:** предыдущая подготовка не завершена коммитом. **Лечение:** дождаться завершения текущего масштабирования (`POST /is_scaling_elastic_ep`).
- **Подтверждение принятого значения:** предупреждение о понижении `api_server_count` до 1 и `enable_elastic_ep=True` в стартовой строке конфига.

## Примеры

```bash
vllm serve /models/DeepSeek-V3 --enable-expert-parallel --enable-eplb --enable-elastic-ep --data-parallel-size 4 --data-parallel-backend ray
```

```bash
vllm serve /models/DeepSeek-V3 --enable-expert-parallel --enable-eplb --enable-elastic-ep --data-parallel-size 4 --data-parallel-backend ray --eplb-config.use_async false
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/distributed/parallel_state.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/entrypoints/serve/elastic_ep/api_router.py`
- `vllm/vllm/entrypoints/serve/elastic_ep/middleware.py`
- `vllm/vllm/v1/engine/async_llm.py`
- `vllm/vllm/v1/engine/core_client.py`
- `vllm/vllm/config/vllm.py`
