---
schema: 1
engine: sglang
primaryName: "--speculative-dspark-confidence-sts-path"
title: "--speculative-dspark-confidence-sts-path"
summary: Путь к JSON-калибровке confidence-головы DSPARK (по одной температуре на позицию блока). Влияет только на планировщик ragged-verify: точность выборки не меняется. Без `SGLANG_RAGGED_VERIFY_MODE` ≠ `static` головы нет и файл игнорируется с предупреждением.
group: spec
related:
  - --speculative-algorithm
  - --speculative-dspark-block-size
  - --speculative-dspark-sps-table-path
  - --speculative-dspark-align-verify-tokens-to-graph-tier
  - --speculative-num-draft-tokens
  - --speculative-draft-model-path
---

# --speculative-dspark-confidence-sts-path

## Кратко

Узкоспециальная ручка DSPARK. У его draft-головы есть отдельный «confidence head», который оценивает вероятность выживания каждой позиции блока; ragged-verify планировщик по этим оценкам решает, сколько токенов проверять у какого запроса. Сырые оценки головы обычно откалиброваны плохо, и STS-таблица (sequential temperature scaling) чинит именно это — по одной температуре на позицию. На корректность выхода не влияет никак: verify остаётся точным, меняется только раскладка бюджета.

## Оригинальная справка

```text
DSPARK only. Optional path to a per-position STS (sequential temperature scaling) calibration JSON, fit offline with sglang.benchmark.dspark_sts_fit. Calibrates the confidence-head survival probabilities the ragged-verify scheduler consumes. Omit to use identity (no calibration); losslessness is unaffected either way.
```

## Паспорт аргумента

- Флаги: `--speculative-dspark-confidence-sts-path`
- Группа: `spec`
- Тип значения: строка — путь к JSON-файлу
- Допустимые значения: не ограничены argparse; содержимое разбирается msgspec-структурой `DSparkStsCalibration`
- Значение по умолчанию: `null` — тождественная калибровка (все температуры 1.0)
- Эффективное значение: файл читается только при наличии confidence-головы; голова строится лишь когда `SGLANG_RAGGED_VERIFY_MODE` не равен `static` (значение по умолчанию — как раз `static`). В остальных случаях путь игнорируется с предупреждением
- Где объявлен: `ServerArgs.speculative_dspark_confidence_sts_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, алгоритмо-специфичный: единственный читатель — `DSparkVerifyPlanner`
- Этап применения: инициализация DSPARK-воркера (планировщик verify) → каждый спекулятивный раунд при вычислении confidence

## Что меняет в движке

`DSparkVerifyPlanner.__init__`:

- загружает файл через `load_sts_calibration_from_path`, кладёт `temperatures` в тензор и присваивает его буферу `confidence_head.sts_temperatures`;
- проверяет длину: число температур обязано совпадать с `gamma`, иначе `ValueError` с обеими величинами и предложением перекалибровать или убрать флаг;
- если задан `SGLANG_DSPARK_STS_COLLECT_PATH` (сбор данных для калибровки) и таблица не тождественная — `ValueError`: собирать логиты нужно без калибровки;
- если confidence-головы нет (режим `static` или чекпоинт без обученной головы) — предупреждение `DSpark STS calibration path given but no confidence head present (static mode / head-less checkpoint); ignoring <path>.`

В runtime голова считает `sigmoid(confidence_raw / sts_temperatures)` — то есть температура на позицию — и полученные вероятности выживания уходят в `HostConfidenceBudgetPlanner`, который распределяет бюджет verify-токенов между запросами (`ScheduleVerifyLensTopk`). Ошибка калибровки не портит ответы: она приводит к неоптимальному распределению бюджета, то есть к меньшему `accept len` при той же стоимости шага.

## Значения и формат

- Абсолютный путь к существующему JSON-файлу; отсутствие файла — исключение при инициализации воркера.
- Структура файла: обязательное поле `temperatures` — непустой список положительных чисел длиной ровно `gamma`; опциональные `dataset`, `num_samples`, `ece_before`, `ece_after` (метаданные подгонки, движком не используются).
- Все температуры равны 1.0 — тождественная калибровка, эквивалент незаданного флага (но при сборе данных именно она и требуется).
- Неположительная температура — `ValueError: DSparkStsCalibration temperatures must all be > 0`.
- Файл готовится офлайн: сбор сырых логитов через `SGLANG_DSPARK_STS_COLLECT_PATH`, подгонка — `python -m sglang.benchmark.dspark_sts_fit`.

## Когда использовать

- Работает связка DSPARK + ragged-verify (`SGLANG_RAGGED_VERIFY_MODE=cap-accept` или `compact`), и вы уже сняли профиль на своей нагрузке: калибровка — второй по значимости после `--speculative-dspark-sps-table-path` вход планировщика.
- Сменили гамму или чекпоинт: старую таблицу использовать нельзя, длина проверяется, а смысл температур привязан к конкретной голове.
- Не задавать в режиме `static` (значение по умолчанию): головы нет, файл только сбивает с толку.
- Не пытаться «улучшить качество ответов» этой ручкой: она вообще не участвует в решении о приёме токена. За качество отвечают `--speculative-accept-threshold-single` / `--speculative-accept-threshold-acc`, и там цена как раз в точности.

## Влияние на производительность и память

- Память: одна строка тензора на `gamma` элементов — пренебрежимо.
- Время старта: чтение маленького JSON.
- Throughput: косвенно, через качество раскладки бюджета verify — лучше калибровка, выше средняя длина принятого куска при неизменной стоимости шага.
- На точность выборки: нулевое влияние (`losslessness is unaffected either way`).

## Взаимодействие с другими аргументами

- `--speculative-algorithm DSPARK`: вне его аргумент не читается.
- `--speculative-dspark-block-size` (и `--speculative-num-draft-tokens`): задают `gamma`, под которую подгонялась таблица; несовпадение длины — ошибка старта.
- `--speculative-dspark-sps-table-path`: второй вход того же планировщика (таблица стоимости); без неё в режиме `compact` бюджет вырождается в «проверять всё», и калибровка почти ничего не даёт.
- `--speculative-dspark-align-verify-tokens-to-graph-tier`: использует тот же confidence-порядок при добивании бюджета до тира графа.
- Переменные окружения (не CLI): `SGLANG_RAGGED_VERIFY_MODE` включает сам режим, `SGLANG_DSPARK_STS_COLLECT_PATH` — сбор данных для подгонки.

## Типовые проблемы и диагностика

- `DSpark STS calibration was fit for gamma=8 but the runtime gamma is 7; refit the table for gamma=7 or omit --speculative-dspark-confidence-sts-path.` — длина таблицы не совпала с блоком.
- `DSpark STS calibration path given but no confidence head present (static mode / head-less checkpoint); ignoring …` — режим `static` или чекпоинт без confidence-головы.
- `DSpark STS data collection (SGLANG_DSPARK_STS_COLLECT_PATH) requires identity temperatures …` — вы одновременно собираете данные и применяете калибровку.
- `DSpark ragged-verify mode 'compact' schedules per-request verify lengths from the draft confidence head, but this DSpark draft checkpoint has no confidence head` — не про сам флаг, но соседняя причина: чекпоинт неполный.
- Подтверждение применения: `DSpark STS calibration loaded from <path> (gamma=N); per-position temperatures applied to confidence-head survival.` (печатается только на tp rank 0).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --speculative-algorithm DSPARK --speculative-draft-model-path /models/DeepSeek-V3.2-DSpark-Draft --speculative-dspark-block-size 7 --speculative-dspark-confidence-sts-path /etc/arriero/dspark-sts-gamma7.json
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --speculative-algorithm DSPARK --speculative-draft-model-path /models/DeepSeek-V3.2-DSpark-Draft --speculative-dspark-block-size 7 --speculative-dspark-sps-table-path /etc/arriero/dspark-sps.json --speculative-dspark-confidence-sts-path /etc/arriero/dspark-sts-gamma7.json --max-running-requests 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_sts.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_planner.py`
- `sglang/python/sglang/srt/models/dspark.py`
- `sglang/python/sglang/srt/speculative/ragged_verify.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/environ.py`
