---
schema: 1
engine: sglang
primaryName: "--speculative-adaptive-config"
title: "--speculative-adaptive-config"
summary: Путь к JSON с лестницами `candidate_steps` по диапазонам batch size и коэффициентами EMA-политики adaptive-режима. Читается только вместе с `--speculative-adaptive`; без него файл не открывается вовсе.
group: spec
related:
  - --speculative-adaptive
  - --speculative-num-steps
  - --speculative-num-draft-tokens
  - --speculative-algorithm
  - --cuda-graph-max-bs-decode
---

# --speculative-adaptive-config

## Кратко

Файл описывает, между какими значениями `--speculative-num-steps` разрешено переключаться и насколько инертно. Ключевая часть — набор диапазонов batch size: у каждого своя лестница ступеней и свои гистерезисы, потому что при BS 1 выгодно спекулировать глубоко, а при BS 64 каждая отвергнутая ветка умножается на размер батча. Лестница определяет ещё и стартовую память: буферы и CUDA graph'ы размеряются по её максимуму.

## Оригинальная справка

```text
Path to a JSON config file for adaptive speculative decoding tuning knobs.
```

## Паспорт аргумента

- Флаги: `--speculative-adaptive-config`
- Группа: `spec`
- Тип значения: строка — путь к JSON-файлу
- Допустимые значения: не ограничены argparse; содержимое валидируется при чтении
- Значение по умолчанию: `null` — используется встроенный `DEFAULT_ADAPTIVE_CONFIG`
- Эффективное значение: файл читается **только** если включён `--speculative-adaptive`; иначе значение лежит в `ServerArgs` без всякого эффекта
- Где объявлен: `ServerArgs.speculative_adaptive_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_init_adaptive_speculative_params` → `resolve_candidate_steps_from_config`) → размер буферов и захват CUDA graph по ступеням → инициализация `AdaptiveSpeculativeParams` в воркере

## Что меняет в движке

`_load_adaptive_config` разбирает JSON так:

- **ключ из цифр** (`"1"`, `"8"`, `"32"`) — нижняя граница диапазона batch size. Слот обязан содержать `candidate_steps` — непустой список неотрицательных целых; иначе `ValueError` с номером слота;
- **остальные ключи верхнего уровня** — глобальные значения, которые подмешиваются в каждый слот (`cfg = {**cfg, **entry}`), то есть слотовое значение всегда перекрывает глобальное;
- если ни одного цифрового ключа нет — `ValueError` с подсказкой формата.

Из объединения всех `candidate_steps` собирается `resolve_candidate_steps_from_config`, и он используется дважды: как лестница переключений и как **верхняя граница draft-токенов** (`max(candidate_steps) + 1`) для размерности буферов и графов.

Читаемые политикой параметры и их значения по умолчанию (`AdaptiveStepSlot`): `ema_alpha` = 0.2 (скорость EMA), `update_interval` = 5 (раз в сколько verify-батчей пересчитывать), `warmup_batches` = 10 (сколько батчей не трогать ступень), `down_hysteresis` = −0.25 и `up_hysteresis` = 0.0 (запас перед понижением/повышением), `ceiling_coeff` = 0 (при > 0 включает потолок `ceil(ema × coeff)`, который только опускает ступень и никогда не мешает подниматься).

Встроенный дефолт в коде:

```json
{
  "1":  {"candidate_steps": [1, 3, 7], "up_hysteresis": 0.0, "down_hysteresis": -0.25, "ceiling_coeff": 0},
  "8":  {"candidate_steps": [0, 1, 3], "up_hysteresis": 0.0, "down_hysteresis": 0.0,   "ceiling_coeff": 0},
  "32": {"candidate_steps": [0, 1],    "up_hysteresis": 0.0, "down_hysteresis": 0.0,   "ceiling_coeff": 0},
  "64": {"candidate_steps": [0],       "up_hysteresis": 0.0, "down_hysteresis": 0.0,   "ceiling_coeff": 0}
}
```

Апстрим-документация (`adaptive_speculative_decoding.mdx`) приводит «консервативный» дефолт без нулевых ступеней и утверждает, что `candidate_steps` — список **положительных** целых. Код на этом commit'е принимает и `0`, и сам использует его в дефолте: ступень `0` означает «на этом диапазоне BS не драфтить», а политика периодически пробует подняться на первую положительную ступень.

## Значения и формат

- Абсолютный путь к существующему файлу; он открывается обычным `open()`, отсутствие файла — `FileNotFoundError` на старте.
- Ключи диапазонов — строки из цифр (`"8"`, не `8`). Диапазон трактуется как «от этого значения BS и выше, пока не начнётся следующий»; конкретный BS сначала подтягивается вверх до ближайшего захваченного размера CUDA graph, потом отображается на слот.
- Нецифровые ключи верхнего уровня (`ema_alpha`, `warmup_batches`, `update_interval`) — глобальные; слот может их переопределить.
- Списки ступеней могут содержать `0`; отрицательные значения отвергаются.
- Файл читается несколько раз в процессе старта (лестница нужна и для размерности буферов, и для политики), поэтому редактировать его во время работы бессмысленно — изменения подхватятся только на перезапуске.

## Когда использовать

- Встроенная лестница не подходит под ваш профиль: например, вся нагрузка идёт при BS 1–4 и вам нужны ступени `[1, 3, 7]` без «нулевых» веток для больших батчей.
- Нужно ограничить стартовую память: лестница `[1, 3]` вместо `[0, 1, 3, 7]` уменьшает и число наборов графов, и размер буферов draft-токенов.
- Политика дёргается слишком часто: поднимите `warmup_batches`/`update_interval` или добавьте `down_hysteresis`.
- Не задавать, если `--speculative-adaptive` не включён: файл не будет прочитан, а конфигурация будет выглядеть настроенной.
- Не копировать конфиг из апстрим-документации дословно, не сверив с кодом установленной версии: набор дефолтных ступеней там уже расходится с реализацией.

## Влияние на производительность и память

- VRAM и время старта: определяются максимумом лестницы и числом достижимых ступеней — по набору CUDA graph'ов на каждую.
- Latency/throughput: через качество политики. Слишком широкая лестница удлиняет старт и даёт лишние переключения, слишком узкая обесценивает adaptive-режим.
- Сам файл ни на что не влияет после старта: параметры фиксируются в объектах политики.

## Взаимодействие с другими аргументами

- `--speculative-adaptive`: без него файл не читается.
- `--speculative-num-steps`: заданное значение обязано входить в объединение всех `candidate_steps`, иначе старт падает.
- `--speculative-num-draft-tokens`: вычисляется как `steps + 1`; предельное значение для буферов — `max(candidate_steps) + 1`.
- `--cuda-graph-max-bs-decode` / `--disable-cuda-graph`: определяют, какие BS вообще захвачены; слоты без достижимых BS исключаются из захвата.
- `--speculative-algorithm`: только EAGLE/EAGLE3.

## Типовые проблемы и диагностика

- `FileNotFoundError` на старте — путь не существует на том узле, где поднимается воркер.
- `BS 8: candidate_steps must be a list of non-negative ints, got None` — в слоте нет обязательного списка.
- `speculative_adaptive_config must contain at least one integer-string BS key, e.g. {"1": {"candidate_steps": [1,3,7]}}. Got keys: [...]` — в файле только глобальные параметры.
- `--speculative-num-steps=5 is not in the adaptive config candidate_steps [1, 3, 7]` — стартовая ступень не из лестницы.
- Что смотреть: `AdaptiveSpeculativeParams initialized: steps=…, candidate_steps=[…]` — по этой строке видно, какая лестница реально применилась; дальше `Adaptive spec params updated: steps A -> B (ema_accept_len=…)`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE --speculative-draft-model-path /models/EAGLE-LLaMA3.1-Instruct-8B --speculative-eagle-topk 1 --speculative-adaptive --speculative-adaptive-config /etc/arriero/adaptive-spec.json
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE --speculative-draft-model-path /models/EAGLE-LLaMA3.1-Instruct-8B --speculative-eagle-topk 1 --speculative-num-steps 3 --speculative-adaptive --speculative-adaptive-config /etc/arriero/adaptive-spec.json --max-running-requests 16
```

Содержимое `/etc/arriero/adaptive-spec.json` для второго примера:

```json
{
  "ema_alpha": 0.2,
  "warmup_batches": 10,
  "update_interval": 5,
  "1": {"candidate_steps": [1, 3], "down_hysteresis": -0.25},
  "16": {"candidate_steps": [1]}
}
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/adaptive_spec_params.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/runtime_context.py`
- `sglang/docs/docs/advanced_features/adaptive_speculative_decoding.mdx`
