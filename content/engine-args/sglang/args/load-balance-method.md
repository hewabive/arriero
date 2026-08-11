---
schema: 1
engine: sglang
primaryName: "--load-balance-method"
title: "--load-balance-method"
summary: Политика, по которой встроенный `DataParallelController` раскладывает запросы по DP-группам. Значение `auto` раскрывается в `round_robin`, а в PD-prefill — в `follow_bootstrap_room`.
group: parallel
related:
  - --dp-size
  - --enable-dp-attention
  - --disaggregation-mode
  - --elastic-ep-backend
  - --max-ep-size
  - --tokenizer-worker-num
  - --enable-metrics
---

# --load-balance-method

## Кратко

Аргумент действует только там, где есть `DataParallelController`, то есть при `--dp-size > 1` (или в режиме elastic-scale). Он выбирает одну из четырех реальных политик распределения входящих запросов по DP-группам: круговую, привязку к `bootstrap_room` для PD-развертываний и две нагрузочные — по числу запросов и по числу токенов. Пятое значение `auto` — это не политика, а «подставь дефолт по `--disaggregation-mode`», и оно раскрывается сразу в `__post_init__`.

## Оригинальная справка

```text
The load balancing strategy for data parallelism.
```

## Паспорт аргумента

- Флаги: `--load-balance-method`
- Группа: `parallel`
- Тип значения: str
- Допустимые значения: `auto`, `round_robin`, `follow_bootstrap_room`, `total_requests`, `total_tokens` (список фиксирован в объявлении поля, не собирается в runtime)
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` никогда не доживает до контроллера. `_handle_load_balance_method` заменяет его на `follow_bootstrap_room` при `--disaggregation-mode prefill` и на `round_robin` во всех остальных случаях (включая `--disaggregation-mode decode`). Тот же метод первым делом валидирует `disaggregation_mode` и бросает `ValueError` на неизвестном значении
- Где объявлен: `ServerArgs.load_balance_method`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_load_balance_method`) → конструктор `DataParallelController` (`LoadBalanceMethod.from_str`, выбор функции диспетчеризации) → каждый входящий запрос

## Что меняет в движке

Контроллер один раз выбирает функцию по таблице и дальше зовет ее на каждый запрос (`managers/data_parallel_controller.py`):

- **`round_robin`** — счетчик по кругу среди **активных** воркеров. Неактивные слоты пропускаются; если активных нет, поднимается `RuntimeError: No active DP workers are available for routing.`
- **`follow_bootstrap_room`** — `target_rank = req.bootstrap_room % len(self.workers)`. Требует, чтобы у запроса был `bootstrap_room`; иначе `AssertionError` с подсказкой «не шлите запросы напрямую в prefill/decode-инстансы, шлите в роутер». Это политика PD-disaggregation, обеспечивающая, что prefill и decode одного запроса попадут в согласованные ранги.
- **`total_requests`** — рангу с минимальным `num_running_reqs + num_waiting_reqs`.
- **`total_tokens`** — рангу с минимальным `num_total_tokens`, при равенстве — с меньшим числом запросов.

Две последние читают снимки нагрузки из shared memory (`create_load_snapshot_reader`) и включают `refresh_load_budget_on_dispatch`. Обновление снимка троттлится: не чаще одного раза в 20 мс. Между обновлениями бюджет ведется спекулятивно — после каждой отправки соответствующему рангу прибавляется `+1` запрос и оценка токенов (`len(req.input_ids)`). Комментарий в коде объясняет, зачем: без троттлинга при пакете запросов бюджет каждый раз сбрасывался бы к устаревшему снимку и весь пакет уезжал бы на один ранг.

Любая политика обходится, если клиент прислал явный `routed_dp_rank` (`maybe_external_dp_rank_routing`) или если у scheduler-процесса выставлена переменная `SGLANG_DP_RANK`.

## Значения и формат

- Строка ровно из списка `choices`; argparse отвергнет опечатку сразу.
- `auto` — единственное «мета-значение». Оно не сохраняется: в дампе `server_args=` вы увидите уже раскрытое.
- `follow_bootstrap_room` вне PD-развертывания приведет к падению на первом же запросе без `bootstrap_room`.
- При `--dp-size 1` значение не используется вовсе: контроллера нет.

## Когда использовать

- Оставьте `auto` в подавляющем большинстве случаев: `round_robin` — разумный дефолт, а для PD-prefill правильный выбор подставится сам.
- `total_tokens` — когда запросы сильно разной длины и круговая раскладка приводит к перекосу по KV-заполнению. Это единственная политика, учитывающая размер запроса.
- `total_requests` — когда запросы примерно одинаковые, но время жизни разное (длинные генерации).
- `round_robin` явно — когда нужен детерминизм раскладки или когда требует другой режим (elastic EP scale-up принимает только его).
- Не рассчитывайте на cache-aware маршрутизацию: ни одна встроенная политика не знает про radix-кеш. Для этого апстрим предлагает SGLang Model Gateway (`python -m sglang_router.launch_server`), а не этот аргумент.

## Влияние на производительность и память

- **VRAM/RAM.** Не влияет.
- **Throughput.** На разнородной нагрузке `total_tokens` заметно ровнее раскладывает KV-давление, чем `round_robin`; на однородной разницы почти нет.
- **Latency.** Нагрузочные политики добавляют чтение shm-снимка (не чаще 20 мс) на пути диспетчеризации — стоимость мала относительно самого запроса.
- **Hit rate префиксного кеша.** Круговая раскладка разносит запросы с общим префиксом по разным репликам и портит radix-кеш. Это фундаментальное ограничение встроенного балансировщика, не настраиваемое этим аргументом.
- **Пакетные вставки.** `dispatch_batch_generate`/`dispatch_batch_embedding` обновляют бюджет один раз на пакет, дальше работают спекулятивные счетчики.

## Взаимодействие с другими аргументами

- `--dp-size`: аргумент имеет смысл только при значении `> 1`.
- `--disaggregation-mode`: определяет раскрытие `auto` (`prefill` → `follow_bootstrap_room`, `null`/`decode` → `round_robin`).
- `--enable-dp-attention`: не меняет выбор политики, но меняет то, чем является «DP-группа» (см. `dp-size.md`).
- `--elastic-ep-backend` + `--max-ep-size` в режиме scale-up: `assert self.load_balance_method == "round_robin"` с пояснением, что нагрузочным политикам после масштабирования нужны снимки по глобальным рангам.
- `--enable-metrics`: снимки нагрузки живут отдельно от метрик, но обе подсистемы читают одни и те же счетчики планировщика.
- `--tokenizer-worker-num`: при значении > 1 владельцем zmq-читателя снимков становится `MultiTokenizerRouter`; политика от этого не меняется.

## Типовые проблемы и диагностика

- `ValueError: Invalid load balance method: <name>` из `LoadBalanceMethod.from_str` — значение прошло argparse, но не совпало с элементом перечисления.
- `AssertionError: req.bootstrap_room should not be None. Do not send requests directly to prefill or decode instances; send to the router instead.` — `follow_bootstrap_room` вне PD-контура.
- `RuntimeError: No active DP workers are available for routing.` / `Cannot route request: all N active DP workers are unavailable.` — все воркеры помечены неактивными (падение реплики, идущее масштабирование).
- `AssertionError: Elastic EP scale-up requires --load-balance-method round_robin; …` — нагрузочная политика в elastic-конфигурации.
- Весь пакет запросов уехал на один ранг — ожидаемое поведение при пакете короче окна 20 мс, если смотреть на снимок, а не на спекулятивные счетчики; в норме счетчики это компенсируют.
- Раскрытое значение видно в дампе `server_args=` при старте; распределение по рангам — по префиксам ` DP<n>` в строках лога и по метрикам, если включен `--enable-metrics`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --dp-size 4 --load-balance-method total_tokens
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --load-balance-method round_robin --ep-size 8 --moe-a2a-backend deepep
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/managers/load_snapshot.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/docs/docs/advanced_features/dp_dpa_smg_guide.mdx`
