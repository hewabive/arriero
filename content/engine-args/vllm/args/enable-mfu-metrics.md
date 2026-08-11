---
schema: 1
engine: vllm
primaryName: "--enable-mfu-metrics"
title: "--enable-mfu-metrics"
summary: Включает аналитическую оценку FLOPs и трафика памяти на каждый шаг движка: три счётчика в `/metrics` и строка `MFU: ... TF/s/GPU ... GB/s/GPU` в периодическом логе. Цифры считаются по формулам, а не измеряются железом.
group: ObservabilityConfig
related:
  - --disable-log-stats
  - --enable-logging-iteration-details
  - --cudagraph-metrics
  - --enable-per-request-metrics
  - --tensor-parallel-size
  - --pipeline-parallel-size
---

# --enable-mfu-metrics

## Кратко

MFU (Model FLOPs Utilization) здесь — не измерение, а модель: движок разбирает состав каждого запланированного шага (сколько prefill-токенов, сколько decode-токенов, какой контекст у каждого запроса) и по аналитическим формулам компонентов модели считает, сколько операций и байт этот шаг «должен был» стоить. Дальше значения делятся на реальное время и превращаются в TF/s и GB/s на GPU.

Цена — цикл на Python по всем запросам батча в каждом шаге, внутри критического пути `update_from_output`. В движке есть собственный измеритель этой цены: при `VLLM_DEBUG_MFU_METRICS=1` в debug-лог выводится поле `mfu_calc_overhead` — доля интервала, ушедшая на сам расчёт.

## Оригинальная справка

```text
Enable Model FLOPs Utilization (MFU) metrics.
```

## Паспорт аргумента

- Флаги: `--enable-mfu-metrics`, `--no-enable-mfu-metrics`
- Группа argparse: `ObservabilityConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: гасится дважды. Во-первых, `ModelMetrics` создаётся только при `self.log_stats and enable_mfu_metrics`, то есть `--disable-log-stats` его отключает. Во-вторых, если для этой архитектуры не удалось построить ни одного `ComponentMetrics`, `is_enabled()` возвращает `False`, и расчёт не выполняется — сообщения о неудачных компонентах пишутся уровнем `debug`
- Где объявлен: `vllm/config/observability.py:ObservabilityConfig.enable_mfu_metrics`
- Этап применения: инициализация планировщика (построение модели компонентов) → каждый шаг (`Scheduler.update_from_output`) → стат-логгеры

## Что меняет в движке

**Построение модели.** `ModelMetrics(vllm_config)` перебирает зарегистрированные `ComponentMetrics` и для каждого пытается собрать описание из конфига. Успешные пишутся в лог как `Instantiated ComponentMetrics [<тип>] with (<параметры>)`; неудачные проглатываются с debug-сообщением `Failed to instantiate <тип> from <причина>`. Если успешных нет — метрики не считаются вообще.

**Расчёт на шаг.** `get_step_perf_stats_per_gpu(scheduler_output)` строит `ExecutionContext`: проходит по `scheduled_new_reqs` (считаются prefill) и по `scheduled_cached_reqs` (prefill, если запланировано больше одного токена, иначе decode), накапливая суммы токенов, длин контекста и их произведений. Затем три вызова — `get_num_flops_breakdown`, `get_read_bytes_breakdown`, `get_write_bytes_breakdown` — суммируют вклад компонентов, и результат складывается в `PerfStats`. Величины уже приведены «на один GPU», то есть учитывают `--tensor-parallel-size` и `--pipeline-parallel-size`.

**Экспорт.** `PerfMetricsProm.observe()` инкрементирует три счётчика Prometheus:

- `vllm:estimated_flops_per_gpu_total`,
- `vllm:estimated_read_bytes_per_gpu_total`,
- `vllm:estimated_write_bytes_per_gpu_total`.

Средние значения получают через `rate(...)` — готовые PromQL-выражения приведены в docstring `PerfMetricsProm`.

**Периодический лог.** `PerfMetricsLogging.log()` печатает раз в интервал строку `MFU: <TF/s> TF/s/GPU <GB/s> GB/s/GPU` и обнуляет накопители. Если за интервал не набралось ни одной ненулевой величины, строка не печатается.

**Отладочный режим.** При `VLLM_DEBUG_MFU_METRICS=1` дополнительно ведётся `PerfMetricsDebugLogging`: в debug-лог уходит JSON с разбивкой по компонентам (`flops_breakdown`, `num_read_bytes_breakdown`, `num_write_bytes_breakdown`, `context_breakdown`), числом prefill/decode запросов и полем `mfu_calc_overhead`.

## Значения и формат

- Значение по умолчанию `false`; «не задан» и `--no-enable-mfu-metrics` эквивалентны.
- Итоговый MFU в процентах движок не считает: он даёт TF/s и GB/s, а деление на пиковую производительность карты остаётся за вами.
- Величины оценочные. Они не учитывают реальную эффективность ядер, паддинг CUDA graph и повторные вычисления после вытеснения — только состав запланированного шага.

## Когда использовать

- Нужно понять, во что упирается инстанс — в compute или в память: соотношение TF/s и GB/s за один и тот же интервал отвечает на этот вопрос без профилировщика.
- Сравнение конфигураций (chunked prefill, размеры батча, квантизация) по одинаковой методике на одном железе.
- Не используйте как источник абсолютной истины о загрузке GPU: для этого есть телеметрия NVML и профилировщик.
- Не включайте в постоянной эксплуатации на латентно-чувствительном инстансе, не измерив `mfu_calc_overhead` под своей нагрузкой.

## Влияние на производительность и память

- **CPU движка.** Цикл на Python по всем запросам шага плюс сумма формул по компонентам — на каждом шаге, синхронно, в процессе EngineCore. Чем больше `--max-num-seqs`, тем дороже. Точную цифру даёт `mfu_calc_overhead` при `VLLM_DEBUG_MFU_METRICS=1`.
- **VRAM.** Не влияет: расчёт полностью аналитический, тензоры не создаются.
- **RAM хоста.** Три целочисленных накопителя плюс словари разбивок в отладочном режиме.
- **Время старта.** Незначительно: разовое построение компонентов с логированием.
- **Сеть/диск.** Три дополнительные серии в `/metrics` и одна строка в лог за интервал.

## Взаимодействие с другими аргументами

- `--disable-log-stats`: полностью отключает механизм (`ModelMetrics` не создаётся).
- `--tensor-parallel-size`, `--pipeline-parallel-size`: учитываются в приведении величин «на один GPU».
- `--enable-logging-iteration-details`: даёт состав шага построчно; вместе с MFU показывает, какому составу батча соответствует какая расчётная загрузка.
- `--cudagraph-metrics`: показывает паддинг, который MFU в расчёт не берёт, — полезная поправка при интерпретации.
- `--enable-per-request-metrics`: другая разрезка (по запросам), не связанная с этой.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, счётчиков `vllm:estimated_*` в `/metrics` нет. **Причина:** либо задан `--disable-log-stats`, либо для этой архитектуры не построился ни один компонент. **Проверка:** строки `Instantiated ComponentMetrics [...]` в логе старта; при их отсутствии поднять уровень логирования до debug и посмотреть `Failed to instantiate ...`. **Лечение:** для неподдержанной архитектуры флаг бесполезен.
- **Симптом:** строка `MFU: ...` не появляется в логе. **Причина:** за интервал не набралось ненулевых величин (движок простаивал) либо метрики не считаются. **Лечение:** проверить наличие нагрузки.
- **Симптом:** после включения выросла latency под большим батчем. **Причина:** стоимость расчёта на шаг. **Проверка:** `VLLM_DEBUG_MFU_METRICS=1` и поле `mfu_calc_overhead` в debug-логе. **Лечение:** выключить флаг в проде, оставить для замеров.
- **Симптом:** расчётные TF/s заметно выше того, что показывает профилировщик. **Причина:** оценка не учитывает эффективность ядер и паддинг. **Лечение:** трактовать значения как относительные, а не абсолютные.
- **Подтверждение принятого значения:** строки `Instantiated ComponentMetrics [...]` при старте и периодическая строка `MFU: ... TF/s/GPU ... GB/s/GPU`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-mfu-metrics --max-num-seqs 8
```

```bash
vllm serve /models/Qwen3-4B --enable-mfu-metrics --enable-logging-iteration-details --cudagraph-metrics
```

## Источники

- `vllm/vllm/config/observability.py`
- `vllm/vllm/v1/metrics/perf.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/vllm/envs.py`
- `vllm/docs/usage/metrics.md`
