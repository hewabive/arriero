---
schema: 1
primaryName: "--samplers"
title: "--samplers"
summary: "Задает полный порядок sampler-ов по именам через `;`. В отличие от `--sampler-seq`, явно помечает sequence как пользовательскую настройку, поэтому GGUF metadata `general.sampling.sequence` не перезапишет ее при загрузке модели."
category: "Параметры сэмплинга"
valueType: "string"
estimation: "normal"
valueHint: "SAMPLERS"
aliases:
  - "--samplers"
allowedValues: []
env: []
related:
  - "--sampler-seq"
  - "--top-k"
  - "--top-p"
  - "--min-p"
  - "--temp"
  - "--adaptive-target"
---

# --samplers

## Кратко

`--samplers` задает sampler-цепочку по именам, разделенным `;`. Порядок важен: каждый sampler получает результат предыдущего. Если sampler не указан, он не применяется, даже если его числовой параметр задан.

## Оригинальная справка llama.cpp

```text
samplers that will be used for generation in the order, separated by ';' (default: penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature)
```

## Паспорт аргумента

- Основное имя: `--samplers`
- Поле в `common_params`: `params.sampling.samplers`
- HTTP-поле: `samplers`
- CLI-разделитель: `;`
- Дефолт: `penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature`

## Что меняет в llama-server

CLI-парсер делит строку по `;`, преобразует имена через `common_sampler_types_from_names(..., true)` и выставляет user sampling bit `COMMON_PARAMS_SAMPLING_CONFIG_SAMPLERS`. Поэтому sequence из metadata модели не заменит явно заданный `--samplers`.

После обхода указанной цепочки llama.cpp добавляет финальный sampler выбора токена: `dist` по умолчанию или `adaptive_p`, если он был указан в цепочке. При `--mirostat 1/2` обычная цепочка игнорируется и строится отдельная Mirostat-цепочка.

## Значения и формат

Канонические имена:

- `penalties`
- `dry`
- `top_n_sigma`
- `top_k`
- `typ_p`
- `top_p`
- `min_p`
- `xtc`
- `temperature`
- `infill`
- `adaptive_p`

CLI также принимает альтернативы: `top-k`, `top-p`, `top-n-sigma`, `nucleus`, `typical-p`, `typical`, `typ-p`, `typ`, `min-p`, `temp`, `adaptive-p`. Неизвестные имена не прерывают запуск, но логируются warning-ом и пропускаются.

## HTTP API

В JSON поле `samplers` работает иначе:

- массив строк принимает только канонические имена (`allow_alt_names = false`);
- строка трактуется как короткая sequence, как `--sampler-seq`;
- если поле отсутствует, берется дефолт процесса.

Пример массива:

```json
{ "samplers": ["top_k", "top_p", "min_p", "temperature"] }
```

## Когда использовать

- Чтобы полностью отключить конкретный sampler, удалите его из `--samplers`, а не только ставьте "disabled" значение.
- Чтобы зафиксировать порядок и защититься от `general.sampling.sequence` в GGUF metadata, используйте `--samplers`, а не `--sampler-seq`.
- Для `adaptive_p` явно добавьте `adaptive_p`; код все равно поставит его финальным sampler-ом.

## Влияние на производительность и память

Память модели не меняется, но цепочка влияет на CPU/GPU стоимость sampling. `top_k`, `top_p`, `min_p` и `temperature` имеют backend implementations; `typical`, `xtc`, `top_n_sigma`, `adaptive_p`, penalties/DRY могут ограничивать эффективность `--backend-sampling`.

## Взаимодействие с другими аргументами

- Числовые параметры (`--top-k`, `--top-p`, `--temp` и т.д.) работают только если соответствующий sampler присутствует в цепочке.
- `--sampler-seq` задает ту же структуру, но через символы и без user sampling bit.
- `--mirostat` заменяет обычную цепочку.
- `--backend-sampling` зависит от совместимости всей активной цепочки и условий запроса.

## INI-пресеты и router-режим

Ключ INI:

```ini
[fixed-chain]
samplers = penalties;dry;top_k;top_p;min_p;temperature
```

Sampling options разрешены в `--models-preset`. В router-режиме preset модели может задать собственную цепочку; запросы могут заменить ее через `"samplers"`.

## Типовые проблемы и диагностика

- Параметр sampler-а задан, но не влияет: sampler отсутствует в цепочке.
- Опечатка в имени sampler-а: ищите warning `unable to match sampler by name`.
- `adaptive_p` в середине строки фактически будет применен в конце.
- Trace-лог `sampler chain` показывает фактически собранную цепочку, включая `?sampler` для пустых/отключенных sampler-ов.

## Примеры

```bash
llama-server --model /models/model.gguf --samplers "top_k;top_p;min_p;temperature"
```

```bash
llama-server --model /models/model.gguf --samplers "penalties;dry;top_k;top_p;temperature;adaptive_p" --adaptive-target 0.2
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/common/preset.cpp`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/README.md`
