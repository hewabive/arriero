---
schema: 1
engine: vllm
primaryName: "--enable-flash-late-interaction"
title: "--enable-flash-late-interaction"
summary: Считает MaxSim для late-interaction (ColBERT-подобных) моделей на GPU в worker'е вместо переноса матриц токенных эмбеддингов в процесс API-сервера. Включено по умолчанию.
group: Frontend
related:
  - --runner
  - --convert
  - --max-num-batched-tokens
  - --enable-prefix-caching
---

# --enable-flash-late-interaction

## Кратко

Один из немногих аргументов группы `Frontend`, у которого значение по умолчанию — `true`. Он относится только к пулинговому скорингу late-interaction: `/score`, `/v1/score`, `/rerank` и их варианты на ColBERT-подобных моделях.

Обычный путь тянет из движка полные матрицы `[len × dim]` для каждого запроса и каждого документа и перемножает их в процессе API-сервера. Flash-путь оставляет эмбеддинги запроса на worker'е и возвращает уже скалярные оценки.

## Оригинальная справка

```text
If set, run pooling score MaxSim on GPU in the API server process.
Can significantly improve late-interaction scoring performance.
```

## Паспорт аргумента

- Флаги: `--enable-flash-late-interaction`, `--no-enable-flash-late-interaction`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` (`false`); при отсутствии обоих действует `true`
- Значение по умолчанию: `true`
- Эффективное значение: применяется только когда пулинговая задача модели отображается в `late-interaction` (`SCORE_TYPE_MAP`: `token_embed → late-interaction`); для архитектуры `JinaForRanking` принудительно выключается — io-процессор заменяется на `jina-reranking-scoring`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.enable_flash_late_interaction`
- Этап применения: инициализация пулингового состояния (выбор io-процессора) → HTTP-слой, обработка каждого scoring-запроса

## Что меняет в движке

`ServingScores.__init__` (`vllm/entrypoints/pooling/scoring/serving.py`) вычисляет `enable_flash_late_interaction = (io_processor_name == "late-interaction") and <флаг>` и при истине переключает имя процессора на `flash-late-interaction`. `__call__` тогда идет не в базовую реализацию, а в `flash_late_interaction`, состоящую из двух этапов:

1. **Кодирование запросов.** Каждому запросу выдается `PoolingParams.late_interaction_params` с `mode="cache_query"`, стабильным `query_key` вида `<request_id>-query-<i>` и счетчиком `query_uses` — сколько документов будет сверяться с этим запросом. Токенные эмбеддинги остаются в кэше worker'а; `query_key` используется и для DP-маршрутизации, чтобы документы попали на тот же worker.
2. **Кодирование документов.** Каждый документ получает `mode="score_doc"` со ссылкой на `query_key` и возвращает уже готовый скаляр.

Базовый путь (`LateInteractionIOProcessor._post_process`) вместо этого получает от движка обе матрицы и вызывает `compute_maxsim_score` на стороне API-сервера.

Пара «1 запрос × N документов» обрабатывается специально: при одном запросе `query_uses` равен числу документов, и запрос кодируется один раз на всю пачку.

## Значения и формат

- Выключение: `--no-enable-flash-late-interaction`. Включение (избыточно, это дефолт): `--enable-flash-late-interaction`.
- «Не задан» = `true` — противоположно большинству булевых аргументов этой группы.
- На моделях, чей скоринг не `late-interaction` (bi-encoder, cross-encoder), значение не имеет эффекта: условие в конструкторе не выполняется.
- Гранулярности по эндпоинтам нет.

## Когда использовать

- Оставьте значение по умолчанию: на ColBERT-подобных моделях это заметно дешевле по объему передаваемых данных.
- Выключайте только при подозрении на расхождение оценок между flash- и базовым путем: `--no-enable-flash-late-interaction` дает эталонный расчет на стороне API-сервера, с которым можно сравнить.
- Не трогайте на генеративной модели: аргумент относится к пулинговому скорингу и там не применяется.

## Влияние на производительность и память

- **Передача данных.** Основной выигрыш: вместо матриц `[длина × размерность]` по каждому запросу и документу через IPC уходят скаляры. На длинных документах и больших пачках это доминирующая часть стоимости.
- **VRAM.** Кэш токенных эмбеддингов запроса живет на worker'е до тех пор, пока не отработают все `query_uses` документов. Это дополнительная память на устройстве, пропорциональная длине запроса и числу одновременно обслуживаемых запросов.
- **RAM хоста и CPU.** Снижаются: MaxSim больше не считается в процессе API-сервера.
- **Latency.** Скоринг выполняется в два прохода (сначала все запросы, затем документы), поэтому короткая пачка из одного документа выигрывает меньше, чем длинная.

## Взаимодействие с другими аргументами

- `--runner`, `--convert`: определяют, будет ли модель обслуживать пулинговые задачи и попадет ли ее задача в `late-interaction`; без этого флаг неприменим.
- `--max-num-batched-tokens`: скоринг пачками упирается в тот же бюджет батча, что и генерация.
- `--enable-prefix-caching`: при повторяющихся запросах в 1×N-сценарии сокращает prefill; работает независимо от этого флага.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, поведение не изменилось. **Причина:** модель не late-interaction либо архитектура `JinaForRanking`, где flash-путь принудительно выключен. **Проверка:** тип пулинговой задачи модели в логе старта. **Лечение:** действий не требуется.
- **Симптом:** оценки отличаются от эталонного расчета. **Причина/проверка:** сравнить с запуском `--no-enable-flash-late-interaction` на тех же входах — это и есть эталонный путь. **Лечение:** при подтвержденном расхождении оставаться на базовом пути.
- **Симптом:** нехватка VRAM на пачках с длинными запросами. **Причина:** кэш эмбеддингов запроса удерживается на worker'е до обработки всех документов. **Лечение:** уменьшить размер пачки документов на запрос либо понизить `--max-num-batched-tokens`.
- **Подтверждение принятого значения:** отключение флага видно в строке `non-default args: {...}` при старте (значение по умолчанию — `true`, поэтому в этой строке появляется именно выключение).

## Примеры

```bash
vllm serve /models/colbert-v2 --runner pooling --enable-flash-late-interaction
```

```bash
vllm serve /models/colbert-v2 --runner pooling --no-enable-flash-late-interaction
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/pooling/scoring/serving.py`
- `vllm/vllm/entrypoints/pooling/scoring/io_processor.py`
- `vllm/vllm/entrypoints/pooling/factories.py`
- `vllm/vllm/pooling_params.py`
- `vllm/vllm/tasks.py`
