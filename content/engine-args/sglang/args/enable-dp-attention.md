---
schema: 1
engine: sglang
primaryName: "--enable-dp-attention"
title: "--enable-dp-attention"
summary: Переводит внимание с тензорного параллелизма на data-параллельный — каждая DP-группа считает свои запросы со своим KV-кешем, а FFN/MoE остаются TP/EP. Меняет топологию целиком и молча переписывает несколько соседних аргументов.
group: parallel
related:
  - --dp-size
  - --tp-size
  - --enable-dp-lm-head
  - --enable-dp-attention-local-control-broadcast
  - --chunked-prefill-size
  - --schedule-conservativeness
  - --moe-a2a-backend
  - --ep-size
  - --moe-dense-tp-size
  - --attn-cp-size
  - --mem-fraction-static
  - --enable-two-batch-overlap
  - --enable-attn-tp-input-scattered
  - --dist-init-addr
---

# --enable-dp-attention

## Кратко

`--enable-dp-attention` — самый «топологический» аргумент SGLang. Он не добавляет процессов и не занимает лишних карт: он переразбивает уже существующую TP-группу так, что **внимание** становится data-параллельным (`dp_size` независимых подгрупп, каждая со своим KV-кешем и своим батчем), а **FFN/MoE** остаются тензорно- и экспертно-параллельными по всей группе. Смысл в одном: у MLA-моделей одна KV-голова, и при обычном TP KV-кеш дублируется на каждой карте. Флаг не работает в одиночку — без `--dp-size > 1` он молча выключается, и он молча переписывает `--chunked-prefill-size` и `--schedule-conservativeness`.

## Оригинальная справка

```text
Enabling data parallelism for attention and tensor parallelism for FFN. The dp size should be equal to the tp size. Currently DeepSeek-V2 and Qwen 2/3 MoE models are supported.
```

## Паспорт аргумента

- Флаги: `--enable-dp-attention`
- Группа: `parallel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: присутствует / отсутствует; парного `--no-…` нет
- Значение по умолчанию: `false`
- Эффективное значение: **не совпадает с заданным в обе стороны.** Принудительно `False`, если `dp_size == 1` и `ep_join_mode != "scale"` (`_data_parallelism_defaults` в `arg_groups/overrides.py`) — заданный флаг при этом пропадает без ошибки. Принудительно `True` при `--dwdp-size > 1` (`_handle_dwdp`), при MLA context parallel и при zigzag DSA CP (`overrides.py`), а также в DeepSeek-V4 CP-хуке (`arg_groups/deepseek_v4_hook.py`)
- Где объявлен: `ServerArgs.enable_dp_attention`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; поле помечено `resolvable=True`, то есть итоговое значение собирается движком в конце `__post_init__`, а промежуточные обработчики читают его через `_resolved()`
- Этап применения: `__post_init__` (`_handle_dwdp` → `_handle_gpu_memory_settings` → `_handle_data_parallelism`) → `PortArgs.init_new` (IPC → TCP) → `launch_dp_attention_schedulers` → `initialize_dp_attention` в каждом воркере → каждая итерация планировщика (MLP-sync) → forward

## Что меняет в движке

### Что дублируется, что шардируется

Расклад рангов считает `compute_dp_attention_world_info` (`layers/dp_attention.py`):

```python
attn_dp_size = dp_size if enable_dp_attention else 1
attn_tp_size = tp_size // attn_dp_size // attn_cp_size
attn_tp_rank = tp_rank % attn_tp_size
attn_dp_rank = tp_rank // (attn_tp_size * attn_cp_size)
```

- **Веса внимания шардируются по `attn_tp_size`, а не по `tp_size`.** При `dp_size == tp_size` получается `attn_tp_size == 1`: каждый ранг держит **полную копию** проекций внимания. Это и есть плата за флаг — дублированные веса attention.
- **KV-пул шардируется по `attn_tp_size`**: конфигуратор берет `model_config.get_num_kv_heads(get_parallel().attn_tp_size, …)`. Для MLA (одна KV-голова) при обычном TP каждый ранг все равно получал бы полную копию KV; здесь каждая DP-группа хранит KV **только своих** запросов, поэтому суммарный полезный пул растет в `dp_size` раз.
- **Батчи независимы.** Каждая DP-группа планирует свои запросы и может находиться в своем режиме (prefill, decode, idle).
- **FFN и MoE не меняются**: они остаются TP/EP по всей группе. Токены собираются со всех DP-групп перед MLP (all-gather / a2a) и разбираются обратно после — этим занимаются `LayerCommunicator` и `require_mlp_tp_gather`/`require_attn_tp_gather` (`utils/common.py`).
- **`lm_head`** по умолчанию остается общим и требует all-gather по DP-группам; убрать его — задача `--enable-dp-lm-head`.

### Что аргумент переписывает молча

`_handle_data_parallelism` при включенном DP-attention делает четыре вещи:

1. `self.schedule_conservativeness = self.schedule_conservativeness * 0.3` — умножение на 0.3, без строки в логе. Заданная вами `1.0` станет `0.3`; чтобы сохранить прежнюю осторожность планировщика, значение нужно задавать примерно втрое больше. Механика самого параметра — в `schedule-conservativeness.md`.
2. `assert self.tp_size % self.dp_size == 0`.
3. `self.chunked_prefill_size = self.chunked_prefill_size // self.dp_size` — с предупреждением `DP attention is enabled. chunked prefill size is adjusted from X to Y`. То есть значение `--chunked-prefill-size` трактуется как суммарное по всем DP-группам; подробности — в `chunked-prefill-size.md`.
4. Пересчитывает `max_bs` и список размеров prefill-CUDA-graph под уже поделенный `chunked_prefill_size`, чтобы захват графа не вылез за бюджет MoE all-to-all.

Дополнительно: `PortArgs.init_new` переключается с unix-IPC на TCP (иначе многоузловой DP невозможен), а `--mem-fraction-static` в автоподборе добавляет резерв `decode.max_bs * dp_size * 3` МиБ под графы.

### Синхронный шаг планировщика

Все DP-группы обязаны делать forward одновременно: `prepare_mlp_sync_batch_raw` (`managers/scheduler_components/dp_attn.py`) на каждой итерации собирает all-gather'ом вектор `global_num_tokens` по всем рангам и решает, нужен ли idle-батч. Группа без работы получает `get_idle_batch()` и все равно прогоняет forward. Отсюда два следствия: неравномерная нагрузка по DP-группам напрямую бьет по latency всех, а сама синхронизация — заметная накладная статья, которую и оптимизирует `--enable-dp-attention-local-control-broadcast`.

## Значения и формат

- Флаг без аргумента. «Не задан» = обычный тензорный параллелизм внимания.
- Работает только вместе с `--dp-size > 1`. Задать флаг и оставить `--dp-size 1` — молчаливый no-op.
- `--dp-size` обязан делить `--tp-size`. Канонический вариант из апстрим-документации — `dp_size == tp_size`.
- На нескольких узлах включенный DP-attention обязателен для любого `--dp-size > 1` и требует явного `--dist-init-addr`.

## Когда использовать

- **MLA-модели** (DeepSeek-V2/V3/R1, Kimi-K2, MiniMax) на 4+ картах: это основной сценарий, ради которого флаг существует. При обычном TP KV-кеш дублируется на всех рангах и режет конкурентность; DP-attention убирает дублирование.
- **Qwen 2/3 MoE** — поддержаны явно (оригинальная справка; `dp_dpa_smg_guide.mdx` относит сюда же обычные Qwen со стандартным вниманием).
- **Требование другого флага.** `--moe-a2a-backend flashinfer` требует DP-attention с `dp_size == tp_size`, `pplx` — DP-attention с `dp_size >= 2`, elastic EP scale-up — DP-attention плюс `--enable-dp-lm-head`.
- **Не включайте** на плотных GQA-моделях (Llama, Qwen dense): там KV-головы и так делятся по TP, а DP-attention только продублирует веса внимания и добавит синхронизацию. Апстрим для них рекомендует обычный TP или обычный DP.
- **Не включайте** при `--tp-size 1`: делить нечего.
- **Не включайте** ради экономии VRAM «вообще»: веса внимания при `attn_tp_size == 1` дублируются на каждой карте, выигрыш только на KV.

## Влияние на производительность и память

- **VRAM.** Веса внимания растут (шардирование по `attn_tp_size` вместо `tp_size`), KV-кеш перестает дублироваться. Для MLA баланс резко положительный: одна KV-голова весит копейки на ранг, а пул умножается на `dp_size`.
- **Резерв.** Автоподбор `--mem-fraction-static` закладывает дополнительные `decode.max_bs * dp_size * 3` МиБ (и еще `× 1.5` при `decode.max_bs > 300`) под CUDA graph, то есть при том же железе автоматически подобранный пул станет меньше.
- **Throughput.** Основной выигрыш — на decode крупных MoE-моделей: больший KV-пул означает больший батч. `dp_dpa_smg_guide.mdx` заявляет для связки DP-attention + EP на больших кластерах до 5× относительно обычного TP; это цифра апстрима, а не измерение arriero.
- **Latency.** Ухудшается на малой и неравномерной нагрузке: пустые DP-группы прогоняют idle-батчи, а каждая итерация начинается с коллектива.
- **Время старта.** Практически не меняется; захват CUDA graph занимает больше памяти.
- **Сеть.** Межпроцессный транспорт становится TCP даже на одном узле.

## Взаимодействие с другими аргументами

- `--dp-size`: обязателен (`> 1`), обязан делить `--tp-size`; при `1` гасит этот флаг.
- `--chunked-prefill-size`: делится на `dp_size` (уже документировано в `chunked-prefill-size.md`).
- `--schedule-conservativeness`: умножается на `0.3` (уже документировано в `schedule-conservativeness.md`).
- `--enable-dp-lm-head`: имеет смысл только здесь и жестко требует этот флаг (`assert`).
- `--enable-dp-attention-local-control-broadcast`: снимает часть накладных расходов синхронизации, работает только при DP-attention.
- `--moe-a2a-backend`: `flashinfer` и `pplx` требуют DP-attention; `none` вместе с DP-attention — легальный не-EP путь (и единственный, при котором разрешен `--enable-two-batch-overlap` без a2a-backend).
- `--moe-dense-tp-size`: при `1` плотные MLP становятся полностью DP; влияет на то, нужен ли MLP-gather (`require_mlp_tp_gather`).
- `--attn-cp-size`: делит ту же группу дальше — `attn_tp_size = tp_size // dp_size // attn_cp_size`, требуется `tp_size % (dp_size * attn_cp_size) == 0`.
- `--enable-attn-tp-input-scattered`: взаимоисключающе — scatter-путь включается только при выключенном DP-attention.
- `--dwdp-size`, MLA CP, zigzag DSA CP, DeepSeek-V4 CP: включают этот флаг за вас.
- `--enable-aiter-allreduce-fusion` на DeepSeek/GPT-OSS: соответствующая ветка в `_handle_model_specific_adjustments` срабатывает только при **выключенном** DP-attention и `nnodes == 1`.

## Типовые проблемы и диагностика

- Флаг задан, но в логе нет ни строки `DP attention is enabled. chunked prefill size is adjusted from … to …`, ни префиксов ` DP<n>` — значит `--dp-size` равен 1 и флаг был сброшен `_data_parallelism_defaults`. Это самая частая ошибка конфигурации; ошибку движок не выдает.
- `AssertionError` без текста из `_handle_data_parallelism` — `tp_size % dp_size != 0`.
- `AssertionError: Flashinfer MoE A2A is only supported with dp_size == tp_size and --enable-dp-attention` — a2a-backend требует эту связку.
- `AssertionError: Please enable dp attention when setting enable_dp_lm_head.` — задан `--enable-dp-lm-head` без этого флага.
- Throughput упал после включения на плотной модели — ожидаемо: веса внимания продублированы, а выигрыша по KV нет. Возвращайтесь к обычному TP.
- Latency прыгает при низком RPS — часть DP-групп простаивает и прогоняет idle-батчи; это свойство режима, а не баг. Смягчается более равномерной маршрутизацией.
- OOM на захвате CUDA graph сразу после включения — вырос резерв под графы; уменьшите `--cuda-graph-max-bs-decode` или `--mem-fraction-static`.
- Что смотреть: дамп `server_args=` (там уже поделенный `chunked_prefill_size` и умноженная `schedule_conservativeness`), сводка `max_total_num_tokens=…` на каждом ранге, префиксы ` DP<n> TP<n>` в строках лога.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --enable-dp-lm-head --ep-size 8 --moe-a2a-backend deepep --moe-runner-backend deep_gemm
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tensor-parallel-size 4 --dp-size 4 --enable-dp-attention --chunked-prefill-size 8192 --schedule-conservativeness 3.0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/managers/scheduler_components/dp_attn.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/docs/docs/advanced_features/dp_dpa_smg_guide.mdx`
