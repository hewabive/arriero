---
schema: 1
engine: sglang
primaryName: "--enable-expert-distribution-metrics"
title: "--enable-expert-distribution-metrics"
summary: Включает подсчет и публикацию balancedness — отношения средней загрузки ранга к максимальной на каждом MoE-слое. Заодно поднимает рекордер распределения экспертов в режиме `stat` и сразу стартует запись, без HTTP-вызова.
group: exec.moe
related:
  - --expert-distribution-recorder-mode
  - --expert-distribution-recorder-buffer-size
  - --eplb-min-rebalancing-utilization-threshold
  - --enable-eplb
  - --enable-metrics
  - --ep-size
---

# --enable-expert-distribution-metrics

## Кратко

Флаг включает наблюдаемость перекоса экспертов: на каждом forward-проходе ранг 0 считает `balancedness` = среднее по рангам число токенов на слое, деленное на максимум по рангам, и пишет его в лог (или в метрику Prometheus, если включена соответствующая переменная окружения). Побочный, но обязательный эффект — рекордер распределения экспертов переводится в режим `stat` и начинает запись сразу при инициализации. Второе применение флага не очевидно из названия: без него порог `--eplb-min-rebalancing-utilization-threshold` не работает вообще.

## Оригинальная справка

```text
Enable logging metrics for expert balancedness
```

## Паспорт аргумента

- Флаги: `--enable-expert-distribution-metrics`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-*` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но сам переопределяет `--expert-distribution-recorder-mode` на `stat`, если тот не задан (`_handle_expert_distribution_metrics`, без предупреждения в логе)
- Где объявлен: `ServerArgs.enable_expert_distribution_metrics`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → создание рекордера в model runner (автостарт записи) → конец каждого forward-прохода

## Что меняет в движке

Флаг читается в двух местах `sglang/python/sglang/srt/eplb/expert_distribution.py`:

1. `_ExpertDistributionRecorderReal.__init__` — при включенном флаге вызывается `start_record()` с информационной строкой `ExpertDistributionRecorder auto start record since enable_expert_distribution_metrics`. Обычный рекордер без этого флага молчит, пока не придет `POST /start_expert_distribution_record`.
2. `_UtilizationRateAccumulatorMixin` — флаг включает поле `_enable`, от которого зависит весь расчет balancedness.

Расчет на каждом проходе: счетчики физических экспертов сворачиваются в счетчики по рангам (`compute_gpu_physical_count`), редуцируются `reduce(dst=0)`, затем `compute_utilization_rate` дает по слоям `(mean + 1e-5) / (max + 1e-5)`, и берется среднее по слоям. Значение 1.0 — идеально ровная раскладка, 1/ep_size — вся нагрузка на одном ранге.

Куда уходит результат:

- по умолчанию — в лог ранга 0 строкой `[Expert Balancedness] forward_pass_id=… current_pass_balancedness=… last_10_average_balancedness=… last_100_… last_1000_… gpu_physical_count_sum=…`;
- при `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1` — в Prometheus-summary `sglang:eplb_balancedness` через обычный конвейер метрик планировщика, а лог-строка не печатается;
- при `SGLANG_EPLB_HEATMAP_COLLECTION_INTERVAL=N` (N > 0) дополнительно раз в N проходов заполняется гистограмма `sglang:eplb_gpu_physical_count` с меткой слоя — это тепловая карта «слой × ранг».

Скользящие окна фиксированы в коде: 10, 100 и 1000 проходов. Окно 1000 — то самое, которое читает EPLB при решении, пропускать ли перебалансировку.

## Значения и формат

- Флаг без значения. Отсутствие флага — balancedness не считается, а рекордер (если он вообще создан) стартует только по HTTP.
- Флаг не отменяет явного `--expert-distribution-recorder-mode`: если вы поставили `per_token`, останется `per_token`, и balancedness будет считаться поверх детального сборщика.

## Когда использовать

- Перед включением EPLB: сначала измерьте перекос. Если `last_1000_average_balancedness` близко к 1.0, балансировать нечего и EPLB даст только накладные расходы.
- Обязательно, если вы задаете `--eplb-min-rebalancing-utilization-threshold` меньше 1.0: без этого флага история balancedness не наполняется, `_get_global_average_utilization_rate()` возвращает `None`, и порог никогда не срабатывает.
- Не включайте на инстансе без экспертного параллелизма: при `ep_size == 1` balancedness тождественно равен 1.0.
- Не включайте «просто для логов» на латентно-чувствительном декоде: расчет тянет `reduce` и `.item()` на каждом проходе.

## Влияние на производительность и память

- **Latency.** На каждом forward-проходе: `reduce` тензора `(num_layers, ep_size)` на ранг 0 плюс `.item()` — то есть синхронизация GPU→CPU. На коротких decode-проходах это заметная доля шага. С `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1` `.item()` уходит из горячего пути (значение переносится вместе с остальными метриками), но только если `--eplb-min-rebalancing-utilization-threshold` оставлен равным 1.0.
- **VRAM.** Сам флаг новых буферов не добавляет, но включает рекордер, а тот выделяет кольцевой буфер `--expert-distribution-recorder-buffer-size` (см. соответствующий документ).
- **Throughput.** Прямого выигрыша нет: аргумент только измеряет. Выигрыш дает то, что вы сделаете по результатам измерения.

## Взаимодействие с другими аргументами

- `--expert-distribution-recorder-mode`: подставляется в `stat`, если не задан; флаг также включает автостарт записи.
- `--expert-distribution-recorder-buffer-size`: определяет VRAM, которую утянет включенный рекордер.
- `--eplb-min-rebalancing-utilization-threshold`: порог читает именно ту историю, которую наполняет этот флаг; без флага порог мертв.
- `--enable-eplb`: работает и без метрик, но без них решение о пропуске перебалансировки не принимается.
- `--enable-metrics`: нужен, чтобы `sglang:eplb_balancedness` и `sglang:eplb_gpu_physical_count` вообще уехали в `/metrics`.
- `--ep-size`: при значении 1 метрика вырождается.

## Типовые проблемы и диагностика

- В логе нет строк `[Expert Balancedness]` — либо рекордер не создан (модель не публикует `get_model_config_for_expert_location`), либо выставлена `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC`, и значение уходит в метрику вместо лога.
- Метрика `sglang:eplb_balancedness` пуста при включенном флаге — не выставлена `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC` либо не включен `--enable-metrics`.
- `sglang:eplb_gpu_physical_count` пуста — по умолчанию `SGLANG_EPLB_HEATMAP_COLLECTION_INTERVAL=0`, то есть тепловая карта выключена.
- EPLB не пропускает перебалансировку, хотя порог задан ниже 1.0 — проверьте, что этот флаг включен; иначе окно истории пустое и порог не применяется.
- Просадка latency сразу после включения флага — ожидаемая цена per-pass синхронизации; на проде оставляйте флаг только на время измерения либо переносите метрику в Prometheus-путь.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --enable-expert-distribution-metrics --enable-metrics
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --enable-eplb --enable-expert-distribution-metrics --eplb-min-rebalancing-utilization-threshold 0.9
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/environ.py`
