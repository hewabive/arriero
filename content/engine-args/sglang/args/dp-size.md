---
schema: 1
engine: sglang
primaryName: "--dp-size"
title: "--dp-size"
summary: Число data-parallel групп. Без `--enable-dp-attention` это независимые реплики модели за встроенным балансировщиком, с ним — разбиение той же TP-группы на DP-подгруппы внимания.
group: parallel
related:
  - --enable-dp-attention
  - --enable-dp-lm-head
  - --load-balance-method
  - --tp-size
  - --pp-size
  - --chunked-prefill-size
  - --schedule-conservativeness
  - --nnodes
  - --dist-init-addr
  - --moe-a2a-backend
  - --base-gpu-id
  - --gpu-id-step
---

# --dp-size

## Кратко

`--dp-size` — единственный аргумент SGLang, значение которого меняет смысл в зависимости от соседнего флага. Сам по себе он поднимает `dp_size` **независимых реплик** модели, каждая со своей TP-группой и своим KV-кешем, за встроенным `DataParallelController`. Вместе с `--enable-dp-attention` он ничего не реплицирует, а разбивает ту же самую TP-группу на `dp_size` подгрупп внимания. Значение по умолчанию `1`; при `dp_size == 1` движок принудительно гасит и `--enable-dp-attention`, и `--enable-dp-lm-head`.

## Оригинальная справка

```text
The data parallelism size.
```

## Паспорт аргумента

- Флаги: `--dp-size`, `--data-parallel-size`. Сокращение `--dp` работает как однозначный префикс argparse, но объявленным алиасом не является
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет
- Значение по умолчанию: `1`
- Эффективное значение: переписывается в `_handle_dwdp` — при `--dwdp-size > 1` выставляется `dp_size = dwdp_size` вместе с принудительными `enable_dp_attention/enable_dp_lm_head/enable_dp_attention_local_control_broadcast = True`. Обратный эффект: при `dp_size == 1` (и `ep_join_mode != "scale"`) правило `_data_parallelism_defaults` гасит `enable_dp_attention` и `enable_dp_lm_head`
- Где объявлен: `ServerArgs.dp_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_dwdp` → `_handle_data_parallelism` (проверка `tp_size % dp_size == 0`, деление `--chunked-prefill-size`, множитель `--schedule-conservativeness`) → `PortArgs.init_new` (IPC или TCP) → запуск `DataParallelController` → маршрутизация каждого запроса

## Что меняет в движке

### Режим A: `--dp-size N` без DP-attention (native DP)

`_launch_scheduler_processes` видит `dp_size > 1` и вместо голых scheduler-процессов поднимает `DataParallelController`. Тот в `launch_dp_schedulers` создает по потоку на реплику, каждой выдает собственные ZMQ-порты и собственный `nccl_port`, а базовый GPU сдвигает на целую TP-группу:

```python
base_gpu_id += server_args.tp_size * server_args.pp_size * server_args.gpu_id_step
```

Итого требуется `dp_size * tp_size * pp_size` GPU, и каждая реплика держит полную копию весов и собственный KV-пул. Запросы раскладывает `--load-balance-method`; `control_message_step = 1`, то есть управляющие сообщения уходят каждой реплике.

Апстрим прямо помечает этот режим как «highly not recommended for use right now» и предлагает вместо него SGLang Model Gateway с тем же флагом, но другой точкой входа: `python -m sglang_router.launch_server --dp-size 4`. Причины — отсутствие cache-aware маршрутизации, метрик и отказоустойчивости.

### Режим B: `--dp-size N --enable-dp-attention`

Реплик не появляется. `dp_size` становится числом DP-групп внутри одной TP-группы:

```python
attn_dp_size = dp_size
attn_tp_size = tp_size // attn_dp_size // attn_cp_size
attn_dp_rank = tp_rank // (attn_tp_size * attn_cp_size)
```

Требуется `tp_size % dp_size == 0` (жесткий `assert` в `_handle_data_parallelism`). Подробности того, что при этом дублируется, а что шардируется, — в `enable-dp-attention.md`.

В этом режиме `PortArgs.init_new` переключает межпроцессное взаимодействие с unix-IPC на TCP (иначе многоузловой запуск невозможен) и выводит служебные порты из `--dist-init-addr` либо, на одном узле, из `--port + 233`.

## Значения и формат

- Целое ≥ 1. `1` — data-параллелизма нет; это же значение молча выключает `--enable-dp-attention`, даже если флаг задан явно.
- В режиме DP-attention обязана выполняться делимость `tp_size % dp_size == 0`; типовые варианты — `dp_size == tp_size` (по одной attention-реплике на карту) или `dp_size = tp_size / 2`.
- Native DP на нескольких узлах запрещен: `assert not (dp_size > 1 and nnodes != 1 and not enable_dp_attention)` с текстом `multi-node data parallel is not supported unless dp attention!`.
- Клиент может обойти балансировщик, указав `routed_dp_rank` в запросе; значение проверяется по диапазону `[0, dp_size)`, а при `dp_size <= 1` игнорируется с предупреждением в логе.

## Когда использовать

- Модель помещается в одну карту (или в маленькую TP-группу), а карт много и нужен throughput: native DP или, лучше, SMG-роутер поверх независимо запущенных экземпляров.
- MLA-модель на нескольких картах: `--dp-size` равный `--tp-size` вместе с `--enable-dp-attention` — стандартная конфигурация DeepSeek/Kimi, дающая непродублированный KV-кеш.
- Не задавайте `--dp-size` «на всякий случай» вместе с `--enable-dp-attention`: при `1` флаг DP-attention просто исчезнет из конфигурации без ошибки, и вы получите обычный TP.
- Не используйте native DP как способ «разложить» инстансы по картам в arriero: менеджер видит один процесс с суммарным потреблением, а память все равно надо резервировать на всех задействованных GPU. Несколько отдельных инстансов дают ту же изоляцию и наблюдаемость на уровне менеджера.

## Влияние на производительность и память

- **Native DP.** VRAM умножается на `dp_size`: веса и KV-пул полностью реплицируются. Throughput растет почти линейно при независимых запросах и не растет вовсе, если запросы делят общий префикс, — встроенные политики не знают про radix-кеш.
- **DP-attention.** VRAM на ранг не меняется от `dp_size` напрямую, но KV-кеш перестает дублироваться: суммарный полезный пул растет в `dp_size` раз для моделей с одной KV-головой.
- **`--chunked-prefill-size`.** В режиме DP-attention делится на `dp_size` — то есть значение, которое вы задаете, трактуется как суммарное по всем DP-группам. Механика описана в `chunked-prefill-size.md`.
- **`--schedule-conservativeness`.** В том же режиме умножается на `0.3`; см. `schedule-conservativeness.md`.
- **Резерв под CUDA graph.** При DP-attention (и `--disaggregation-mode` не `prefill`) автоподбор `--mem-fraction-static` добавляет `decode.max_bs * dp_size * 3` МиБ, а при `decode.max_bs > 300` еще `decode.max_bs * dp_size * 1.5`. Рост `dp_size` уменьшает автоматически подобранный KV-пул.
- **Latency.** В DP-attention каждый шаг планировщика синхронизирует все DP-группы; ранг без работы все равно прогоняет idle-батч. Неравномерная нагрузка по группам напрямую бьет по latency.
- **Хост.** Native DP: `dp_size * tp_size * pp_size` процессов, столько же копий весов в page cache при загрузке.

## Взаимодействие с другими аргументами

- `--enable-dp-attention`: полностью меняет смысл аргумента; при `dp_size == 1` сам гасится.
- `--enable-dp-lm-head`: требует DP-attention, значит и `dp_size > 1`.
- `--load-balance-method`: работает только в этом режиме — балансировщик существует лишь когда есть `DataParallelController`.
- `--tp-size`: в DP-attention — делимость `tp_size % dp_size == 0`; в native DP — множитель числа занятых карт.
- `--dwdp-size`: перетирает `dp_size` своим значением.
- `--moe-a2a-backend flashinfer` требует `dp_size == tp_size`, `pplx` — `dp_size >= 2` (см. `moe-a2a-backend.md`).
- Elastic EP scale-up требует `dp_size == tp_size` и `--load-balance-method round_robin`.
- `--nnodes`: native DP на нескольких узлах запрещен.
- `--base-gpu-id` / `--gpu-id-step`: определяют, с какой карты начинается первая реплика и с каким шагом идут остальные.

## Типовые проблемы и диагностика

- `AssertionError: multi-node data parallel is not supported unless dp attention!` — `--dp-size > 1` при `--nnodes > 1` без `--enable-dp-attention`.
- `AssertionError` в `_handle_data_parallelism` без текста (`assert self.tp_size % self.dp_size == 0`) — `dp_size` не делит `tp_size` при включенном DP-attention.
- `--enable-dp-attention` задан, а в логе никаких следов DP (нет строки `DP attention is enabled. chunked prefill size is adjusted…`, нет префиксов ` DP<n>`) — значит `--dp-size` остался равным 1 и флаг был сброшен `_data_parallelism_defaults`.
- `ValueError: routed_dp_rank=… out of range [0, N)` — клиент прислал номер реплики вне диапазона.
- `Port is already in use.` с перечислением `dist_init_port=… port_base=… detokenizer_port=…` — при DP-attention занята одна из шести производных TCP-портов; смените `--dist-init-addr` или `--port`.
- Строки лога получают префикс ` DP<rank>` всегда, когда есть DP-контроллер; имя процесса — `sglang::scheduler_DP1_TP0`. Итоговое `dp_size` — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --ep-size 8 --moe-a2a-backend deepep
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --dp-size 4 --load-balance-method total_tokens --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
- `sglang/docs/docs/advanced_features/dp_dpa_smg_guide.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
