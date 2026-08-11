---
schema: 1
engine: vllm
primaryName: "--use-tqdm-on-load"
title: "--use-tqdm-on-load"
summary: Включает прогресс-бары при загрузке весов и при захвате CUDA graphs. Включен по умолчанию; `--no-use-tqdm-on-load` убирает из managed-логов десятки строк прогресса, ценой потери единственного индикатора хода долгого старта.
group: LoadConfig
related:
  - --load-format
  - --safetensors-load-strategy
  - --model-loader-extra-config
  - --enforce-eager
  - --disable-log-stats
  - --uvicorn-log-level
---

# --use-tqdm-on-load

## Кратко

Аргумент объявлен в `LoadConfig` и по названию относится к загрузке весов, но фактически управляет двумя разными прогресс-барами: чтением чекпоинта и захватом CUDA graphs в `GPUModelRunner`. Это две самые долгие фазы старта vLLM, и оба индикатора выключаются одним флагом.

Для управляемого сервера это не косметика: stdout/stderr процесса пишутся в файл лога, и прогресс-бары попадают туда целиком.

## Оригинальная справка

```text
Whether to enable tqdm for showing progress bar when loading model
weights.
```

## Паспорт аргумента

- Флаги: `--use-tqdm-on-load`, `--no-use-tqdm-on-load`
- Группа argparse: `LoadConfig`
- Тип значения: bool (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: не ограничены сверх пары флагов
- Значение по умолчанию: `true`
- Эффективное значение: не переопределяется, но дополнительно сужается по рангу — `enable_tqdm()` возвращает истину только если распределенная группа не инициализирована либо `torch.distributed.get_rank() == 0`; бар захвата графов дополнительно обернут проверкой `is_global_first_rank()`
- Где объявлен: `vllm/config/load.py:LoadConfig.use_tqdm_on_load`
- Этап применения: чтение весов; захват CUDA graphs

## Что меняет в движке

1. **Загрузка весов.** Все итераторы в `vllm/model_executor/model_loader/weight_utils.py` (`safetensors_weights_iterator`, `pt_weights_iterator`, `np_cache_weights_iterator`, многопоточные варианты, итератор Run:ai) передают `disable=not enable_tqdm(use_tqdm_on_load)`. Формат бара задан константой `_BAR_FORMAT`, которая **заканчивается переводом строки**:

   ```text
   Loading safetensors checkpoint shards:  33% Completed | 1/3 [00:01<00:02, 1.20it/s]
   ```

   То есть в лог попадает не «перерисовка через `\r`», а отдельная строка на каждое обновление — по строке на шард.

2. **Захват CUDA graphs.** `GPUModelRunner` использует то же поле для бара `Capturing CUDA graphs (decode, FULL)` / `(mixed prefill-decode, ...)`. Здесь формат обычный tqdm-овский, с возвратом каретки.

При многопроцессном запуске бары рисует только нулевой ранг — остальные молчат независимо от значения.

## Значения и формат

- `--use-tqdm-on-load` — бары включены (по умолчанию), `--no-use-tqdm-on-load` — выключены.
- Флаг не влияет на обычные информационные строки: `Loading weights took X.XX seconds`, `Available KV cache memory`, `GPU KV cache size` печатаются в любом случае.
- Отключение не ускоряет загрузку: tqdm стоит доли процента времени фазы.

## Когда использовать

- **`--no-use-tqdm-on-load`** — на управляемом сервере, где логи хранятся и просматриваются: убирает шум и делает старт читаемым. В arriero managed-лог пишется прямо в файл (`runtime/logs/`), фильтр служебных строк рассчитан на HTTP-пробы и прогресс-бары не трогает.
- Оставляйте бары включенными при разбирательстве с медленным стартом: они единственные показывают, в какой именно фазе процесс проводит время (чтение шардов против захвата графов) до открытия HTTP-порта.
- Оставляйте включенными при первом (холодном) старте новой модели: без них минуты тишины неотличимы от зависания.

## Влияние на производительность и память

- **Время старта.** Практически не влияет; накладные расходы tqdm пренебрежимы на фоне ввода-вывода и компиляции.
- **Объем логов.** Основной эффект. Бар загрузки дает по строке на каждое обновление (по числу шардов), бар захвата графов — поток обновлений с возвратом каретки, который в файле выглядит как одна очень длинная строка.
- **VRAM, RAM, throughput.** Не влияет ни на что, кроме вывода.

## Взаимодействие с другими аргументами

- `--load-format`: определяет, какой именно бар вы увидите — `Loading safetensors checkpoint shards`, `Loading pt checkpoint shards`, `Loading np_cache checkpoint shards`, `Multi-thread loading shards`.
- `--safetensors-load-strategy`: в режиме `eager` описание бара получает суффикс `(eager)`; prefetch печатает собственный прогресс (`Prefetching checkpoint files: 10% (x/y)`), который этим флагом **не** отключается — это обычные `logger.info`-строки.
- `--model-loader-extra-config`: `enable_multithread_load` меняет бар на `Multi-thread loading shards`.
- `--enforce-eager`: отключает захват CUDA graphs целиком, вместе со вторым баром.
- `--disable-log-stats`, `--uvicorn-log-level`: управляют другими источниками вывода; прогресс-бары им не подчиняются.

## Типовые проблемы и диагностика

- **Симптом:** managed-лог инстанса наполовину состоит из строк `Loading safetensors checkpoint shards: N% Completed`. **Причина:** бар включен и пишет по строке на обновление. **Лечение:** `--no-use-tqdm-on-load`.
- **Симптом:** флаг выключен, но в логе остались строки прогресса. **Причина:** это не tqdm, а `logger.info` от prefetch (`Prefetching checkpoint files: ...`). **Лечение:** менять `--safetensors-load-strategy`, а не этот флаг.
- **Симптом:** при tensor parallel бары видны только от одного процесса. **Причина:** штатное поведение — рисует только нулевой ранг.
- **Симптом:** старт «висит» без вывода. **Причина:** бары отключены, а фаза действительно долгая (компиляция, захват графов). **Лечение:** временно включить бары; ориентир по времени фаз — `docs/VLLM_OPERATIONS.md` (arriero), где ожидаемый старт около минуты.
- **Подтверждение принятого значения:** наличие или отсутствие строк `Loading ... checkpoint shards` и `Capturing CUDA graphs (...)` в логе старта.

## Примеры

```bash
vllm serve /models/Qwen3-4B --no-use-tqdm-on-load --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --use-tqdm-on-load --load-format safetensors
```

## Источники

- `vllm/vllm/config/load.py`
- `vllm/vllm/model_executor/model_loader/weight_utils.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/model_executor/model_loader/runai_streamer_loader.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/distributed/parallel_state.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
