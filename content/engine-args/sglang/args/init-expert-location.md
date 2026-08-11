---
schema: 1
engine: sglang
primaryName: "--init-expert-location"
title: "--init-expert-location"
summary: Задает стартовую раскладку физических экспертов по рангам EP: либо тривиальную, либо взятую из ранее снятого дампа рекордера распределения экспертов. Это вторая половина связки «записал распределение — воспроизвел раскладку» и единственный способ получить выгоду EPLB без работающего EPLB.
group: exec.moe
related:
  - --expert-distribution-recorder-mode
  - --eplb-algorithm
  - --ep-num-redundant-experts
  - --ep-dispatch-algorithm
  - --enable-eplb
  - --ep-size
  - --enable-waterfill
---

# --init-expert-location

## Кратко

Аргумент читается один раз при инициализации model runner и определяет `ExpertLocationMetadata` — карту «физический слот → логический эксперт» для каждого MoE-слоя. По умолчанию `trivial`: логический эксперт `i` лежит в физическом слоте `i`, редундантные слоты дописываются подряд. Любое другое значение — это данные: путь к `.pt`, путь к `.json` или сам JSON строкой. Практический смысл — воспроизвести на старте раскладку, посчитанную по реальной нагрузке, и получить выровненные ранги без запуска перебалансировки в рантайме.

## Оригинальная справка

```text
Initial location of EP experts.
```

## Паспорт аргумента

- Флаги: `--init-expert-location`
- Группа: `exec.moe`
- Тип значения: str — литерал `trivial`, путь к файлу либо inline-JSON
- Допустимые значения: `choices` нет; разбор целиком в `compute_initial_expert_location_metadata`
- Значение по умолчанию: `trivial`
- Эффективное значение: не переопределяется, но само меняет умолчание `--ep-dispatch-algorithm`: любое значение, кроме `trivial`, включает ту же подстановку, что и `--enable-eplb` (`dynamic` при `--moe-a2a-backend none`, иначе `static`)
- Где объявлен: `ServerArgs.init_expert_location`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (подстановка dispatch-алгоритма) → инициализация model runner (`maybe_init_expert_location_metadata`), до загрузки весов экспертов

## Что меняет в движке

Разбор в `sglang/python/sglang/srt/eplb/expert_location.py`, функция `compute_initial_expert_location_metadata`:

1. `trivial` → `ExpertLocationMetadata.init_trivial`: `physical_to_logical_map` строится как `arange(base_num_physical_experts) % num_logical_experts`, где `base = num_logical_experts + --ep-num-redundant-experts`, затем недостающие слоты дозаполняются `append_trivial_expert_slots`.
2. Строка оканчивается на `.pt` → `torch.load(..., weights_only=True, map_location="cpu")`.
3. Строка оканчивается на `.json` → содержимое файла разбирается как JSON.
4. Иначе строка сама разбирается как JSON.

Полученный словарь ветвится по ключам:

- есть `physical_to_logical_map` → `init_by_mapping`: карта берется как есть. Если ширина карты равна базовому числу физических экспертов, а `--ep-num-redundant-experts` больше нуля, недостающие слоты дописываются тривиально; при несовпадении ширины после этого — ассерт.
- есть `logical_count` → `init_by_eplb`: движок один раз, на старте, прогоняет алгоритм из `--eplb-algorithm` по этим счетчикам и получает раскладку. Это и есть «статический EPLB»: расстановка посчитана по вашей статистике, но дальше не меняется.
- ни того, ни другого → `NotImplementedError: Unknown init_expert_location format (...)`.

Метаданные вычисляются в каждом воркере отдельно (файл читается всеми рангами) и передаются в `moe_ep_rank`-зависимый расчет `logical_to_all_physical_map`. Дальше карта участвует в загрузке весов экспертов, в выборе физической реплики на forward (`ExpertLocationDispatchInfo`) и, если включен `--enable-eplb`, становится стартовой точкой для перебалансировки.

## Значения и формат

- `trivial` — раскладка по порядку; никаких файлов не читается.
- Путь к `.pt` — ровно тот файл, который пишет `POST /dump_expert_distribution_record` в режиме `stat`/`stat_approx`: он содержит ключи `rank`, `logical_count`, `average_utilization_rate_over_window`, то есть уходит в ветку `logical_count`.
- Путь к `.json` или inline-JSON — удобно, когда карта посчитана снаружи: `--init-expert-location '{"physical_to_logical_map": [[0,1,2,...], ...]}'`.
- Дампы режимов `per_pass`/`per_token` **не подходят**: в них ключи `records` и `last_physical_to_logical_map`, ни один из которых не распознается, — будет `NotImplementedError`.
- Файл должен существовать на каждом узле, где стартует воркер: путь разрешается локально в каждом процессе.

## Когда использовать

Штатный воспроизводимый цикл — записать распределение, затем подставить его как стартовую раскладку:

1. Поднять сервер с `--expert-distribution-recorder-mode stat` и зафиксированным `--deepep-mode` (`normal` или `low_latency`, но не `auto`).
2. `POST /start_expert_distribution_record`.
3. Прогнать репрезентативную нагрузку (ту же модель запросов, что в проде; статистика тем устойчивее, чем крупнее батчи).
4. `POST /stop_expert_distribution_record`, затем `POST /dump_expert_distribution_record`. В логе появится `Write expert distribution to /tmp/expert_distribution_recorder_<time>.pt` (каталог задается `SGLANG_EXPERT_DISTRIBUTION_RECORDER_DIR`).
5. Перезапустить сервер с `--init-expert-location /tmp/expert_distribution_recorder_<time>.pt` и тем же `--ep-size`, `--tp-size` и `--ep-num-redundant-experts`, что при записи.

Подтверждение приема — строка `init_expert_location from init_by_eplb using ServerArgs.init_expert_location` (или `... from init_by_mapping ...`) в логе старта.

Когда трогать не надо: если нагрузка каждый день другая, статическая раскладка быстро протухнет — тогда честнее `--enable-eplb`, который пересчитывает ее на живую. И наоборот: если нагрузка стабильна, статическая раскладка дешевле, потому что не тянет ни рекордер, ни паузы на перенос весов.

## Влияние на производительность и память

- **VRAM.** Сама раскладка — несколько небольших int-тензоров формы `(num_layers, num_physical_experts)`. Реальный расход добавляет `--ep-num-redundant-experts`, а не этот аргумент.
- **Время старта.** Ветка `logical_count` дополнительно прогоняет алгоритм EPLB на CPU один раз; на масштабах DeepSeek-V3 это секунды, не минуты. Ветка `physical_to_logical_map` практически бесплатна.
- **Throughput.** Выигрыш ровно тот же, что у EPLB: меньше простоя самого загруженного ранга на каждом MoE-слое, — но без пауз на перенос весов в рантайме.
- Раскладка влияет на то, какие веса экспертов попадут на какой ранг при загрузке, поэтому изменение файла требует перезапуска, а не переконфигурации.

## Взаимодействие с другими аргументами

- `--expert-distribution-recorder-mode`: производит входные данные; годятся только `stat` и `stat_approx`.
- `--eplb-algorithm`: применяется, если во входных данных `logical_count`.
- `--ep-num-redundant-experts`: должен совпадать с тем, что было при записи, иначе ширина карты не сойдется (для `physical_to_logical_map`) или раскладка будет посчитана под другое число слотов.
- `--ep-dispatch-algorithm`: получает автоматическое значение, как только аргумент отличен от `trivial`.
- `--enable-eplb`: совместимы — стартовая раскладка берется отсюда, дальше ее переписывает менеджер.
- `--ep-size`, `--tp-size`: раскладка привязана к числу рангов; переносить файл между конфигурациями с другим `ep_size` нельзя.
- `--enable-waterfill`: в апстрим-рецепте DeepSeek-V4 статическая раскладка и Waterfill применяются вместе.

## Типовые проблемы и диагностика

- `NotImplementedError: Unknown init_expert_location format (...)` — подан дамп `per_pass`/`per_token` или чужой JSON; нужен файл с `logical_count` либо с `physical_to_logical_map`.
- `FileNotFoundError` на одном из узлов — файл не разложен по всем хостам многоузловой конфигурации.
- `AssertionError` в `init_by_mapping` на сравнении ширины карты — `--ep-num-redundant-experts` при запуске не тот, что при записи.
- `JSONDecodeError` — inline-значение не является валидным JSON и не оканчивается на `.pt`/`.json`; проверьте кавычки в командной строке.
- В логе нет ни `init_expert_location from ...`, ни изменений — значение осталось `trivial`; сверьтесь с дампом `server_args=` при старте.
- Подробную раскладку до и после включает переменная `SGLANG_LOG_EXPERT_LOCATION_METADATA`.

## Примеры

Запись распределения:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --expert-distribution-recorder-mode stat
```

Воспроизведение раскладки на следующем запуске:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --init-expert-location /tmp/expert_distribution_recorder_1754900000.0.pt --ep-num-redundant-experts 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_location.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/basic_usage/native_api.mdx`
- `sglang/docs/cookbook/autoregressive/DeepSeek/DeepSeek-V4.mdx`
