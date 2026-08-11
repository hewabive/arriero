---
schema: 1
engine: sglang
primaryName: "--enable-aiter-allreduce-fusion"
title: "--enable-aiter-allreduce-fusion"
summary: ROCm-путь слияния all-reduce с Residual + RMSNorm через ядра aiter. Работает только на HIP и только при `SGLANG_USE_AITER=1`; несовместим с context parallel и с детерминированным режимом, которые отвергают или сбрасывают его.
group: exec.comm
related:
  - --flashinfer-allreduce-fusion-backend
  - --enforce-disable-flashinfer-allreduce-fusion
  - --enable-deterministic-inference
  - --attn-cp-size
  - --moe-dp-size
  - --ep-size
  - --moe-a2a-backend
  - --enable-dp-attention
  - --disable-custom-all-reduce
  - --tp-size
---

# --enable-aiter-allreduce-fusion

## Кратко

Обычная последовательность в конце блока трансформера — all-reduce выхода слоя, затем сложение с residual, затем RMSNorm. Три ядра, два обхода памяти по одному и тому же тензору. Флаг разрешает слить их в одно ядро aiter (`forward_with_allreduce_fusion` у `RMSNorm`), что убирает лишние чтения-записи HBM и часть latency. Это ROCm-функция: включается только если сборка на HIP **и** в окружении задан `SGLANG_USE_AITER=1`. Отдельно стоит запомнить, что флаг не «просто оптимизация»: `check_server_args` жестко запрещает его при context parallel, детерминированный режим его сбрасывает, а для MiniMax-M3 на ROCm он еще и управляет тем, останется ли включенным custom all-reduce.

## Оригинальная справка

```text
Enable Aiter AllReduce Fusion.
```

## Паспорт аргумента

- Флаги: `--enable-aiter-allreduce-fusion`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: сбрасывается в `False` при `--enable-deterministic-inference` (`_handle_deterministic_inference`, warning `Disable --enable-aiter-allreduce-fusion because deterministic inference is enabled.`) и реестром переопределений для MiniMax-M3 на ROCm при `ep_size > 1` с `--moe-a2a-backend none` (warning про порчу частичных выходов разреженного MoE). При `attn_cp_size > 1` или `moe_dp_size > 1` значение не сбрасывается, а **отвергается** ассертом `Aiter allreduce fusion is not supported with context parallelism`
- Где объявлен: `ServerArgs.enable_aiter_allreduce_fusion`, файл — `sglang/python/sglang/srt/server_args.py`; поле помечено `resolvable=True`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (детерминированный сброс, модельные переопределения) → `check_server_args` (ассерты CP) → построение слоев (`layers/communicator.py`) → каждый forward

## Что меняет в движке

Значение читают три места, и все три требуют выполненного `_use_aiter`:

```python
_use_aiter = get_bool_env_var("SGLANG_USE_AITER") and is_hip()
```

Это ключевой момент: без переменной окружения `SGLANG_USE_AITER=1` флаг не делает ничего даже на ROCm-сборке, и никакого предупреждения об этом не печатается.

- `layers/communicator.py:apply_aiter_all_reduce_fusion(tensor)` — предикат применимости на каждый вызов: `_use_aiter`, флаг включен, последняя размерность ≤ 16384, суммарный размер ≤ 64 МиБ (`8 * 1024 * 8192` байт — в коде это явно приведено к границе `max_size / 2` у aiter-ядра custom all-reduce), `tp_size != 6` и DP-attention выключен. Если предикат истинен и у слоя нормализации есть `forward_with_allreduce_fusion`, вызывается слитый путь вместо пары «all-reduce → layernorm».
- `layers/layernorm.py` — страховка корректности: если слитое ядро вернуло `None` (нет подходящей реализации), при `_use_aiter and enable_aiter_allreduce_fusion` выполняется обычный `tensor_model_parallel_all_reduce` и затем обычный `forward` нормализации. То есть отказ здесь мягкий и незаметный.
- `models/qwen3_5.py` — дополнительная ветка со слиянием квантования в fp8 после фьюжена; отключается отдельно через `SGLANG_DISABLE_FUSED_AR_QUANT=1`.

### Что заменяет в пути all-reduce

Заменяется не сам транспорт, а весь хвост слоя: слитое ядро само выполняет редукцию по TP-группе и сразу считает `residual + x` и RMSNorm. Поэтому цепочка выбора `ca → qr → pymscclpp → torch_symm_mem → pynccl` для этих слоев не выполняется вовсе. На ROCm это меняет и роль custom all-reduce: для MiniMax-M3 реестр переопределений оставляет custom AR включенным ровно тогда, когда aiter-фьюжен активен, и выключает его (в пользу NCCL и quick-reduce) в противном случае.

### Требования к топологии

Специальной топологии флаг не требует — редукция внутри слитого ядра идет по обычной TP-группе на одном узле. Ограничения касаются формы данных (порог 64 МиБ и `tp_size != 6`), а не линков. На многоузловой конфигурации выигрыш ограничен тем же, чем ограничен обычный all-reduce через межузловой канал.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Порог размера не настраивается: тензоры больше 64 МиБ (`8 * 1024 * 8192` байт) или с последней размерностью больше 16384 идут обычным путем.
- `tp_size == 6` исключен предикатом явно.

## Когда использовать

- ROCm-хост (MI300X/MI325X/MI355X), `SGLANG_USE_AITER=1`, `--tp-size` 2–8 (кроме 6), decode-ориентированная нагрузка. Слияние снимает пару обходов HBM на каждый слой, и на decode это видно.
- Не включайте на NVIDIA: `_use_aiter` ложно, эффекта нет. Для CUDA аналог — `--flashinfer-allreduce-fusion-backend`.
- Не включайте вместе с `--enable-dp-attention`: предикат явно требует выключенного DP-attention, слитый путь не сработает ни разу.
- Не включайте вместе с context parallel: сервер не стартует.
- Не включайте в детерминированном режиме — движок все равно сбросит флаг.

## Влияние на производительность и память

- **Latency.** Основной эффект: минус одно-два полных чтения-записи тензора скрытых состояний на слой. На decode с большим числом слоев это проценты TPOT.
- **VRAM.** Слитое ядро экономит временные тензоры между all-reduce и нормализацией; отдельных буферов под фьюжен не выделяется. Экономия скромная и на размер KV-пула не влияет.
- **Throughput.** Заметно на средних батчах; на очень больших тензоры выходят за порог 64 МиБ и путь не применяется.
- **Точность.** Порядок сложения в слитом ядре отличается от обычной пары ядер — отсюда и запрет в детерминированном режиме.
- **Время старта.** Не меняется.

## Взаимодействие с другими аргументами

- `--flashinfer-allreduce-fusion-backend`: CUDA-аналог. В `layers/communicator.py` оба предиката проверяются в одном `or`, но на конкретной платформе истинным может быть только один.
- `--enforce-disable-flashinfer-allreduce-fusion`: выключает только FlashInfer-путь, на aiter не влияет.
- `--enable-deterministic-inference`: принудительно выключает флаг.
- `--attn-cp-size`, `--moe-dp-size`: любое значение больше 1 приводит к ассерту на старте.
- `--ep-size` + `--moe-a2a-backend none` на MiniMax-M3 (ROCm): флаг снимается реестром переопределений.
- `--enable-dp-attention`: делает фьюжен неприменимым.
- `--tp-size`: значение 6 исключено; в остальном определяет размер редуцируемых тензоров.
- `--disable-custom-all-reduce`: на MiniMax-M3/ROCm состояние aiter-фьюжена косвенно решает, будет ли custom AR выключен автоматически.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан на ROCm, разницы нет. **Причина:** не задан `SGLANG_USE_AITER=1`. **Проверка:** переменная окружения инстанса; сообщений об этом движок не печатает.
- **Симптом:** `AssertionError: Aiter allreduce fusion is not supported with context parallelism`. **Причина:** одновременно задан `--attn-cp-size` или `--moe-dp-size` больше 1. **Решение:** убрать один из флагов.
- **Симптом:** предупреждение `Disable --enable-aiter-allreduce-fusion because deterministic inference is enabled.` **Причина:** штатный сброс.
- **Симптом:** предупреждение про MiniMax-M3 и порчу выходов разреженного MoE. **Причина:** реестр переопределений выключил флаг для этой архитектуры при стандартном EP на ROCm.
- **Симптом:** странные значения на выходе при спекулятивном декодировании после включения. **Причина:** несовместимость слитого пути с конкретной моделью. **Решение:** выключить флаг и сравнить.
- **Что смотреть:** итоговый дамп `server_args=` при старте — там видно уже разрешенное значение после всех сбросов.

## Примеры

```bash
SGLANG_USE_AITER=1 python -m sglang.launch_server --model-path /models/GLM-5.1 --tensor-parallel-size 8 --enable-aiter-allreduce-fusion
```

```bash
SGLANG_USE_AITER=1 python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 4 --enable-aiter-allreduce-fusion --disable-custom-all-reduce
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/layers/layernorm.py`
- `sglang/python/sglang/srt/models/qwen3_5.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
