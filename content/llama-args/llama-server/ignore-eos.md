---
schema: 1
primaryName: "--ignore-eos"
title: "--ignore-eos"
summary: "Запрещает выбор EOS/EOG токенов через logit bias `-INFINITY`, чтобы генерация не останавливалась на штатном конце потока. Длина ответа тогда должна ограничиваться `--predict`, stop-строками или клиентским `max_tokens`."
category: "Параметры сэмплинга"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--ignore-eos"
allowedValues: []
env: []
related:
  - "--predict"
  - "--seed"
  - "--temp"
---

# --ignore-eos

## Кратко

`--ignore-eos` заставляет sampler игнорировать end-of-stream/end-of-generation токены. Практически это добавляет logit bias `-INFINITY` для EOG-токенов, чтобы модель не могла выбрать штатный конец ответа.

## Оригинальная справка llama.cpp

```text
ignore end of stream token and continue generating (implies --logit-bias EOS-inf)
```

## Паспорт аргумента

- Основное имя: `--ignore-eos`
- Поле в `common_params`: `params.sampling.ignore_eos`
- HTTP-поле: `ignore_eos`
- Значение по умолчанию: `false`
- Этап применения: после загрузки vocab формируется `logit_bias_eog`; затем bias добавляется в sampling params.

## Что меняет в llama-server

CLI-флаг ставит `params.sampling.ignore_eos = true`. После загрузки модели llama.cpp проверяет наличие EOS token; если vocab не имеет EOS, флаг отключается warning-ом. Затем все EOG-токены vocab добавляются в `logit_bias_eog` с bias `-INFINITY` и копируются в активный `logit_bias`.

На уровне HTTP `server-task.cpp` снова читает `"ignore_eos"` для конкретного запроса и добавляет EOG biases к request sampling params.

## Значения и формат

Это flag без значения:

```bash
llama-server --model /models/model.gguf --ignore-eos
```

В HTTP:

```json
{ "ignore_eos": true }
```

## Когда использовать

- Для тестов, где нужно заставить модель продолжать до лимита токенов.
- Для моделей, которые преждевременно отдают EOS на коротких ответах.
- Не включайте без явного лимита генерации на публичном сервере: ответы могут продолжаться до `max_tokens`/`--predict` и тратить больше compute.

## Влияние на производительность и память

Память почти не меняется: добавляется небольшой список logit biases для EOG-токенов. Основной эффект на производительность косвенный: генерация может стать длиннее, потому что EOS больше не завершает ответ.

## Взаимодействие с другими аргументами

- `--predict` и request `max_tokens` становятся основными ограничителями длины.
- Stop-строки (`--reverse-prompt`/HTTP `stop`) продолжают останавливать вывод на текстовом уровне.
- Пользовательский `logit_bias` в HTTP очищается и собирается заново для запроса; затем при `ignore_eos` добавляются EOG biases.
- `--temp`, `--top-p` и другие sampler-ы не смогут выбрать EOS, если он замаскирован `-INFINITY`.

## INI-пресеты и router-режим

Ключ INI:

```ini
[no-eos]
ignore-eos = true
predict = 256
```

В router-режиме child process наследует дефолт, но запрос может передать `"ignore_eos": false` или `true`.

## Типовые проблемы и диагностика

- Ответы не заканчиваются: это ожидаемо; задайте `--predict`, HTTP `max_tokens` или stop-строки.
- Warning `vocab does not have an EOS token, ignoring --ignore-eos`: для модели нечего маскировать как EOS.
- Если включен `--ignore-eos`, не диагностируйте раннюю остановку только через EOS: проверьте stop-строки, лимит токенов, context limit и ошибки клиента.

## Примеры

```bash
llama-server --model /models/model.gguf --ignore-eos --predict 256
```

```bash
llama-server --model /models/model.gguf --temp 0 --ignore-eos --predict 64
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/tests/unit/test_ignore_eos.py`
- `llama.cpp/tools/server/README.md`
