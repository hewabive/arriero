---
schema: 1
engine: sglang
primaryName: "--speculative-dspark-sps-table-path"
title: "--speculative-dspark-sps-table-path"
summary: Профилированная офлайн JSON-таблица «шагов в секунду» для планировщика ragged-verify DSPARK. Без неё бюджет верификации вырождается в verify-all; сама по себе она включается только при `SGLANG_RAGGED_VERIFY_MODE=cap-accept` или `compact`.
group: spec
related:
  - --speculative-algorithm
  - --speculative-dspark-block-size
  - --speculative-dspark-confidence-sts-path
  - --speculative-dspark-align-verify-tokens-to-graph-tier
  - --speculative-num-draft-tokens
  - --max-running-requests
  - --disable-overlap-schedule
---

# --speculative-dspark-sps-table-path

## Кратко

DSPARK умеет верифицировать не всё предложенное окно целиком, а ровно столько токенов на запрос, сколько окупается — это режим ragged-verify. Чтобы решить, сколько именно, планировщику нужна модель стоимости: как падает пропускная способность шага с ростом числа проверяемых токенов. `--speculative-dspark-sps-table-path` указывает на такую таблицу, снятую заранее профилировщиком на этом же железе и этой же модели. Без неё движок подставляет плоскую заглушку, и планировщик, не видя разницы в стоимости, проверяет всё — то есть выигрыша от ragged-verify нет. Аргумент узкоспециальный: он не действует без переменной окружения `SGLANG_RAGGED_VERIFY_MODE`, отличной от значения по умолчанию `static`.

## Оригинальная справка

```text
DSPARK only. Path to a pre-profiled SPS cost table (JSON) built offline with sglang.benchmark.dspark_sps_profiler, consumed by the ragged-verify scheduler (cap-accept / compact). Omit for an uninitialized flat constant-SPS table: the budget degenerates to verify-all (zero throughput gain by itself).
```

## Паспорт аргумента

- Флаги: `--speculative-dspark-sps-table-path`
- Группа: `spec`
- Тип значения: str — путь к существующему локальному JSON-файлу
- Допустимые значения: `choices` нет
- Значение по умолчанию: `null` — используется `build_uninitialized_sps_table`
- Эффективное значение: не переопределяется; при `null` подставляется плоская таблица с единственной точкой `batch_tokens = 1 → 1.0 steps/s` и `max_batch_tokens = max(1, max_running_requests · num_draft_tokens)`
- Где объявлен: `ServerArgs.speculative_dspark_sps_table_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но узкий: читается только при `--speculative-algorithm DSPARK` и только когда `SGLANG_RAGGED_VERIFY_MODE` не равен `static`
- Этап применения: `_handle_dspark` (предупреждение о бесполезности в `static`) → инициализация DSPARK-планировщика (`build_sps_cost_table`) → планирование бюджета верификации на каждом decode-шаге

## Что меняет в движке

`build_sps_cost_table` (`sglang/python/sglang/srt/speculative/dspark_components/dspark_planner.py`) при заданном пути вызывает `load_sps_table_from_path`, иначе строит заглушку. Загрузчик (`sglang/python/sglang/srt/speculative/dspark_components/dspark_sps.py`) выбирает формат **по содержимому файла**: если в тексте встречается подстрока `"bias_seconds"`, разбирается двумерная `SpsAdditiveCostTable`, иначе одномерная `SpsCostTable`.

- `SpsCostTable` — диагональная модель: массивы `sample_batch_tokens` (строго возрастающие) и `sample_steps_per_sec` одинаковой длины плюс `max_batch_tokens` не меньше наибольшей точки. Поиск — ступенчатый, по нижней границе (`floor_probe_index`). Нарушение любого из инвариантов даёт `ValueError` при загрузке.
- `SpsAdditiveCostTable` — аддитивная модель времени шага: `bias_seconds + interp(bs_probes, alpha_seconds, num_reqs) + interp(m_probes, theta_seconds, num_reqs + budget)`. Обе интерполяции линейные с зажимом по краям; `bias_seconds` обязан быть положительным.

Таблица попадает в `HostConfidenceBudgetPlanner`, который на каждом шаге решает, сколько токенов верификации выделить, опираясь ещё и на голову уверенности черновика. Планировщик создаётся только если `read_ragged_verify_mode()` вернул `cap-accept` или `compact` — при значении по умолчанию `static` (`SGLANG_RAGGED_VERIFY_MODE`, `sglang/python/sglang/srt/environ.py`) его нет вовсе.

Два предупреждения на старте:

- `--speculative-dspark-sps-table-path feeds the ragged-verify budget scheduler, which is off under SGLANG_RAGGED_VERIFY_MODE=static; it will be a no-op.` — путь задан, но режим `static`;
- `DSpark SPS table is uninitialized (flat): the verify budget degenerates to verify-all (zero scheduling gain). Pass a profiled --speculative-dspark-sps-table-path.` — режим `compact`, но таблицы нет; внутренне это выражается флагом `_is_verify_all`.

Информационная строка при удачной инициализации: `DSpark ragged-verify scheduler enabled (mode=…, lag=…, relay_lag=…, sps_table=…, graph_tier=…)`, где `sps_table` — либо ваш путь, либо литерал `uninitialized`.

Дополнительные предусловия режима ragged-verify, не связанные с этим аргументом: `SGLANG_PREP_IN_CUDA_GRAPH=1` (значение по умолчанию — включено) и draft-чекпоинт DSPARK с обученной головой уверенности, иначе инициализация падает с явным сообщением.

## Значения и формат

- Путь к локальному JSON-файлу. Сетевой загрузки нет; несуществующий путь даст обычную `FileNotFoundError` при инициализации планировщика.
- Файл готовится профилировщиком: `python -m sglang.benchmark.dspark_sps_profiler run|fit|all --base-url http://127.0.0.1:30000 --out /path/table.json`. Профилировщик **не** запускает сервер — он подключается к уже работающему DSPARK-инстансу и снимает пропускную способность на серии батчей. Рядом с `--out` пишутся сырые записи (`<stem>.records.jsonl`, `<stem>.rounds.jsonl`), манифест и график.
- Подкоманда `run` собирает данные, `fit` строит таблицу из ранее собранных данных, `all` делает и то и другое.
- Диагональная (одномерная) таблица получается при обычном прогоне; двумерная `SpsAdditiveCostTable` — при прогоне с `--fracs`, для которого сервер-донор должен работать в `SGLANG_RAGGED_VERIFY_MODE=compact`.
- Таблица привязана к конкретной конфигурации: модель, железо, `--tp-size`, `--max-running-requests`, `--speculative-num-draft-tokens`. Файл, снятый на другой конфигурации, формально загрузится и будет молча врать планировщику.

## Когда использовать

- Только при `--speculative-algorithm DSPARK` и только если вы сознательно включаете ragged-verify через `SGLANG_RAGGED_VERIFY_MODE=cap-accept` или `compact`.
- После любого изменения, меняющего стоимость шага: другая модель, другая карта, другой `--tp-size`, другой `--max-running-requests`, другая ширина окна верификации — таблицу надо переснять.
- Не задавать при режиме по умолчанию `static`: аргумент ничего не сделает, кроме предупреждения в логе.
- Не переносить чужие таблицы: это измерение вашего железа, а не свойство модели.

## Влияние на производительность и память

- Память: таблица — небольшой JSON в host-памяти планировщика; на VRAM и на размер KV-пула не влияет.
- Время старта: чтение и валидация файла — пренебрежимо мало.
- Throughput: в этом и смысл аргумента. Без таблицы `compact` вырождается в verify-all, то есть ragged-verify не даёт ничего сверх обычной DSPARK-верификации. С таблицей планировщик режет бюджет верификации там, где он не окупается.
- Latency: планировщик может выбирать более узкое окно при большом батче, что уменьшает время шага; при малом батче поведение близко к verify-all.
- Косвенно на VRAM: через выбор тира графа (`dynamic` / `dp-gathered` / `pinned`) и число фактически верифицируемых токенов.

## Взаимодействие с другими аргументами

- `--speculative-algorithm`: аргумент имеет смысл только для `DSPARK`; при другом алгоритме `_handle_dspark` не выполняется, и значение никогда не читается.
- `--speculative-dspark-block-size`: задаёт `gamma`, а с ним и `--speculative-num-draft-tokens` (`gamma + 1`) — то есть ширину окна, стоимость которого измеряет таблица.
- `--speculative-num-draft-tokens` и `--max-running-requests`: вместе задают `max_batch_tokens` заглушки и определяют диапазон, который должен покрывать профиль.
- `--speculative-dspark-confidence-sts-path`: вторая калибровочная таблица DSPARK (пороги головы уверенности); независима от этой, но обе относятся к одному планировщику.
- `--speculative-dspark-align-verify-tokens-to-graph-tier`: действует только в `compact`; в других режимах предупреждает, что будет no-op.
- `--disable-overlap-schedule`: влияет на `relay_lag` планировщика и на доступность DP-tier gather.

## Типовые проблемы и диагностика

- `--speculative-dspark-sps-table-path feeds the ragged-verify budget scheduler, which is off under SGLANG_RAGGED_VERIFY_MODE=static; it will be a no-op.` — задайте `SGLANG_RAGGED_VERIFY_MODE=cap-accept` или `compact` либо уберите аргумент.
- `DSpark SPS table is uninitialized (flat): the verify budget degenerates to verify-all …` — режим включён, а таблицы нет.
- `ValueError: SpsCostTable requires at least one probe.` / `sample_batch_tokens must be strictly increasing …` / `max_batch_tokens must be >= the largest probe …` / `bias_seconds must be > 0` — повреждённая или неправильно собранная таблица; пересоберите профилировщиком.
- `DSpark ragged-verify mode '…' schedules per-request verify lengths from the draft confidence head, but this DSpark draft checkpoint has no confidence head` — проблема не в таблице, а в чекпоинте черновика.
- `DSpark ragged-verify mode '…' requires SGLANG_PREP_IN_CUDA_GRAPH=1 …` — переменная выключена вручную.
- `invalid SGLANG_RAGGED_VERIFY_MODE='…'; expected one of 'static', 'cap-accept', 'compact'` — опечатка в имени режима; проверка выполняется на старте для любого алгоритма спекуляции.
- Чем подтвердить, что таблица подхвачена: строка `DSpark ragged-verify scheduler enabled (mode=…, sps_table=<ваш путь>, …)`. Если там стоит `uninitialized` — путь не задан. В метриках при `cap-accept` дополнительно появляется `block accept len` в строках `Decode batch`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/dspark-target --speculative-algorithm DSPARK --speculative-draft-model-path /models/dspark-draft --speculative-dspark-block-size 7 --speculative-dspark-sps-table-path /srv/profiles/dspark-sps.json --max-running-requests 48
```

```bash
python -m sglang.launch_server --model-path /models/dspark-target --speculative-algorithm DSPARK --speculative-draft-model-path /models/dspark-draft --speculative-num-draft-tokens 8 --speculative-dspark-sps-table-path /srv/profiles/dspark-sps.json --speculative-dspark-confidence-sts-path /srv/profiles/dspark-sts.json
```

Таблица снимается отдельной командой с уже работающего инстанса — она не запускает сервер сама:

```bash
python -m sglang.benchmark.dspark_sps_profiler all --base-url http://127.0.0.1:30000 --out /srv/profiles/dspark-sps.json
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_planner.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_sps.py`
- `sglang/python/sglang/srt/speculative/ragged_verify.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/sglang/benchmark/dspark_sps_profiler.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
