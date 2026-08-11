---
schema: 1
engine: sglang
primaryName: "--expert-distribution-recorder-mode"
title: "--expert-distribution-recorder-mode"
summary: Включает рекордер распределения экспертов и задает, что именно он накапливает — агрегированные счетчики или полный per-token след. Это единственный переключатель, который переводит рекордер из no-op в рабочее состояние; EPLB и метрики сбалансированности включают его за вас.
group: exec.moe
related:
  - --expert-distribution-recorder-buffer-size
  - --enable-expert-distribution-metrics
  - --enable-eplb
  - --init-expert-location
  - --moe-a2a-backend
  - --deepep-mode
  - --chunked-prefill-size
  - --enable-two-batch-overlap
---

# --expert-distribution-recorder-mode

## Кратко

Рекордер распределения экспертов — подсистема, которая на каждом forward-проходе считает, сколько токенов попало в каждого физического эксперта на каждом MoE-слое. Без этого аргумента (и без флагов, которые его подставляют) создается `_ExpertDistributionRecorderNoop`, и все хуки записи — пустые вызовы. Значение выбирает пару «сборщик за проход + аккумулятор»: `stat`/`stat_approx` держат кольцевой буфер счетчиков и умеют отдать сводку в память (это то, что читает EPLB), `per_pass`/`per_token` копят детальные записи и умеют выгружаться только в файл.

## Оригинальная справка

```text
Mode of expert distribution recorder.
```

## Паспорт аргумента

- Флаги: `--expert-distribution-recorder-mode`
- Группа: `exec.moe`
- Тип значения: перечисление
- Допустимые значения: `stat`, `stat_approx`, `per_pass`, `per_token`
- Значение по умолчанию: `null` — рекордер выключен (no-op)
- Эффективное значение: `stat` подставляется в `__post_init__` двумя местами — `_handle_eplb_and_dispatch` при `--enable-eplb` (с предупреждением `EPLB is enabled. The expert_distribution_recorder_mode is automatically set.`) и `_handle_expert_distribution_metrics` при `--enable-expert-distribution-metrics` (молча)
- Где объявлен: `ServerArgs.expert_distribution_recorder_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → инициализация model runner (`maybe_init_expert_location_metadata` → `ExpertDistributionRecorder.init_new`) → каждый forward-проход → HTTP-эндпоинты записи/дампа

## Что меняет в движке

Значение читается один раз при создании рекордера (`sglang/python/sglang/srt/eplb/expert_distribution.py`). `ExpertDistributionRecorder.init_new` возвращает рабочий рекордер только когда значение не `null`; при этом обязательно наличие `ExpertLocationMetadata`, то есть модель должна реализовывать `get_model_config_for_expert_location` — иначе ассерт на старте.

Рабочий рекордер собирается из двух частей.

**Сборщик за проход** (`_SinglePassGatherer.init_new`), правила в порядке проверки:

1. `per_token` → `_DetailSinglePassGatherer`: хранит все `topk_ids` прохода в тензоре `(num_layers, chunked_prefill_size * 8, 8)` типа int32 на устройстве; несовместим с `--enable-two-batch-overlap` (ассерт).
2. `--moe-a2a-backend mori` → счетчики из low-latency dispatch.
3. `stat_approx` → требует одновременно `--moe-a2a-backend` не `none` **и** `--deepep-mode normal`; иначе `NotImplementedError` на старте.
4. `--moe-a2a-backend deepep` → при `--deepep-mode normal` считает по `topk_ids` (GPU `scatter_add`), при `low_latency` — по счетчикам диспетчера; при `--deepep-mode auto` поднимается `NotImplementedError`.
5. Остальные случаи (`none`, `flashinfer`, `nixl`, `mooncake`, `megamoe`) → счет по `topk_ids`.

**Аккумулятор** (`_Accumulator.get_class`):

- `stat` и `stat_approx` → `_StatAccumulator`: кольцевой буфер на `--expert-distribution-recorder-buffer-size` проходов, при дампе счетчики сворачиваются в `logical_count` и складываются `all_reduce` по всем рангам. Умеет отдать результат объектом — именно это делает EPLB на каждой перебалансировке.
- `per_pass` и `per_token` → `_DetailAccumulator`: python-список записей, растущий до дампа; `--expert-distribution-recorder-buffer-size` он **не** читает, а `dump` содержит `assert output_mode == "file"`.

Из последнего следует жесткое правило: `--enable-eplb` работает только с `stat`/`stat_approx`. С `per_pass`/`per_token` первая же перебалансировка падает ассертом внутри `dump_record(output_mode="object")`.

## Значения и формат

- `stat` — точные счетчики на проход, самый дешевый рабочий режим и единственный, который движок подставляет сам.
- `stat_approx` — счетчики берутся из метаданных DeepEP normal-dispatch на CPU вместо GPU-скана `topk_ids`. Дешевле по GPU, но на малых батчах статистика заметно грубее; сам сборщик пишет в лог `DeepepNormalSinglePassGatherer gathers approximate statistics. If used with small batch size, consider using expert_distribution_recorder_mode=stat.`
- `per_pass` — по записи на каждый forward-проход, без ограничения на число записей.
- `per_token` — плюс полные `topk_ids` каждого токена и метаданные батча (`input_ids`, `positions`, `extend_seq_lens`, режим прохода). Это режим для офлайн-анализа маршрутизации, не для эксплуатации.

Отсутствие аргумента = рекордер не создается вовсе; HTTP-эндпоинты записи в этом случае отвечают исключением `Please set ServerArgs.expert_distribution_recorder_mode to use ExpertDistributionRecorder.`

## Когда использовать

- Нужна разовая карта загрузки экспертов под вашу нагрузку, чтобы потом зафиксировать раскладку через `--init-expert-location`: `stat`, запись через HTTP, дамп в файл.
- Нужны метрики сбалансированности в проде: не трогайте этот аргумент, включайте `--enable-expert-distribution-metrics` — он сам поставит `stat`.
- Не включайте `per_token` на боевом инстансе: тензор `topk_ids` пропорционален `--chunked-prefill-size`, а список записей ничем не ограничен.
- Не включайте рекордер «на всякий случай» вместе с EPLB — EPLB его уже включил, а ручное значение `per_pass`/`per_token` сломает перебалансировку.

## Влияние на производительность и память

- **VRAM, `stat`/`stat_approx`.** Кольцевой буфер `(buffer_size, num_layers, num_physical_experts)` в int32. Для 61 слоя, 256+редундантных физических экспертов и буфера 1000 это порядка 60–70 МиБ на ранг. Буфер выделяется целиком при старте рекордера.
- **VRAM, `per_token`.** `(num_layers, chunked_prefill_size * 8, 8)` int32: при 61 слое и `--chunked-prefill-size 8192` это около 128 МиБ, и он живет постоянно.
- **RAM хоста, `per_pass`/`per_token`.** Записи копируются на CPU и накапливаются в списке до `dump_record`; при длинной записи это неограниченный рост.
- **Latency.** `stat` добавляет один `scatter_add` по `topk_ids` на MoE-слой за проход; `stat_approx` переносит счет на CPU. `per_token` дополнительно синхронизирует `input_ids`/`positions` на CPU каждый проход — заметная просадка.
- Дамп `stat` делает `all_reduce` по всем рангам и на первом вызове дергает `empty_cache()`.

## Взаимодействие с другими аргументами

- `--enable-eplb`: подставляет `stat`, если значение не задано; допускает только `stat`/`stat_approx`.
- `--enable-expert-distribution-metrics`: подставляет `stat` и вдобавок автоматически стартует запись при инициализации рекордера, без HTTP-вызова.
- `--expert-distribution-recorder-buffer-size`: размер кольцевого буфера; на `per_pass`/`per_token` не влияет.
- `--moe-a2a-backend` и `--deepep-mode`: определяют доступный сборщик; пара `deepep` + `auto` с рекордером не поднимается.
- `--enable-two-batch-overlap`: несовместим с `per_token`.
- `--chunked-prefill-size`: задает размер буфера `per_token`.
- `--init-expert-location`: потребитель результата — принимает дамп режима `stat`/`stat_approx`.

## Типовые проблемы и диагностика

- `NotImplementedError` из `_SinglePassGatherer.init_new` на старте — либо `stat_approx` без `--deepep-mode normal`, либо `deepep` + `--deepep-mode auto`. Зафиксируйте режим: `--deepep-mode normal` или `low_latency`.
- `AssertionError` в `_DetailAccumulator.dump` через `--eplb-rebalance-num-iterations` проходов после старта — EPLB запущен с `per_pass`/`per_token`. Переключите на `stat`.
- `ExpertLocationMetadata is required for expert distribution recording` — модель не публикует `get_model_config_for_expert_location`; рекордер для нее не поддерживается.
- `SGLang server is already recording expert ids` — повторный `/start_expert_distribution_record` без дампа; предыдущая статистика сброшена.
- Рост RSS процесса scheduler при включенном `per_pass` — это накопленные записи; выгружайте и сбрасывайте их `/dump_expert_distribution_record`.
- Куда упал дамп, видно по строке `Write expert distribution to <path>`; каталог задается переменной `SGLANG_EXPERT_DISTRIBUTION_RECORDER_DIR` (по умолчанию `/tmp`).
- Итоговое значение после подстановок — в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

Снятие распределения под реальной нагрузкой:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --expert-distribution-recorder-mode stat
```

Далее по HTTP: `POST /start_expert_distribution_record`, прогон нагрузки, `POST /stop_expert_distribution_record`, `POST /dump_expert_distribution_record`.

Детальный офлайн-анализ маршрутизации на одной карте:

```bash
python -m sglang.launch_server --model-path Qwen/Qwen1.5-MoE-A2.7B --expert-distribution-recorder-mode per_token --chunked-prefill-size 2048
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/basic_usage/native_api.mdx`
- `sglang/test/manual/ep/test_eplb.py`
