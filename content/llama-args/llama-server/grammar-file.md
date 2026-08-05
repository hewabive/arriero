---
schema: 1
primaryName: "--grammar-file"
title: "--grammar-file"
summary: "Читает user grammar из файла и использует ее как constraint для генерации. Путь читается на старте процесса; при ошибке открытия llama-server падает с сообщением `failed to open file`."
category: "Параметры сэмплинга"
valueType: "path"
estimation: "normal"
valueHint: "FNAME"
aliases:
  - "--grammar-file"
allowedValues: []
env: []
related:
  - "--grammar"
  - "--json-schema"
  - "--json-schema-file"
  - "--backend-sampling"
---

# --grammar-file

## Кратко

`--grammar-file` делает то же, что `--grammar`, но берет grammar из файла. Это предпочтительный способ для сложных GBNF/BNF-like правил.

Файл читается CLI-парсером при старте `llama-server`; изменения файла после запуска не применяются автоматически.

## Оригинальная справка llama.cpp

```text
file to read grammar from
```

## Паспорт аргумента

- Основное имя: `--grammar-file`
- Алиасы: `--grammar-file`
- Тип CLI-значения: путь `FNAME`
- Поле в `common_params_sampling`: `grammar`
- Тип grammar: `COMMON_GRAMMAR_TYPE_USER`
- Значение по умолчанию: grammar отсутствует
- Ошибка чтения: `error: failed to open file '<path>'`

## Что меняет в llama-server

CLI вызывает helper `read_file(value)` и записывает содержимое файла в `params.sampling.grammar = {COMMON_GRAMMAR_TYPE_USER, content}`. Дальше путь применения такой же, как у `--grammar`: grammar sampler создается с root-правилом `root`.

Путь не сохраняется как путь в runtime params; после чтения остается только текст grammar.

## Значения и формат

Передавайте путь к текстовому файлу grammar. Для управляемого сервера используйте абсолютный путь, чтобы не зависеть от текущего рабочего каталога процесса arriero или router subprocess.

Файл должен быть доступен пользователю, от имени которого запускается `llama-server`.

## Когда использовать

Используйте `--grammar-file` для любых grammar больше одной строки, для правил с кавычками и для production preset-ов. Это снижает риск ошибок экранирования в shell, INI и UI.

Для JSON-форматов сначала рассмотрите `--json-schema-file`: schema обычно проще поддерживать и тестировать, а llama.cpp сам конвертирует ее в grammar.

## Влияние на производительность и память

На старте добавляется чтение небольшого текстового файла. Во время генерации стоимость такая же, как у `--grammar`: CPU-side constraint filtering. KV-cache, RAM модели и VRAM не меняются.

`--backend-sampling` при grammar отключается с warning, потому что backend sampling несовместим с grammar.

## Взаимодействие с другими аргументами

- `--grammar`: inline-альтернатива; если задать несколько grammar/json-schema CLI-аргументов, активным будет последнее записанное значение.
- `--json-schema` и `--json-schema-file`: альтернативные constraint sources.
- `--logit-bias`: не может разрешить токен, запрещенный grammar.
- `--backend-sampling`: отключается при активной grammar.

## INI-пресеты и router-режим

Аргумент является sampling option и разрешен в `--models-preset`. В preset указывайте путь, который виден из subprocess:

```ini
[model.json]
grammar-file = /srv/llama/grammars/answer.gbnf
```

Если router запускает отдельные процессы с другим working directory, относительные пути становятся источником ошибок.

## Типовые проблемы и диагностика

- `failed to open file`: путь неверный или нет прав.
- `Failed to parse grammar`: файл прочитан, но содержимое grammar некорректно.
- Изменили файл, но поведение не поменялось: перезапустите `llama-server`.
- Grammar работает в CLI, но не в manager: проверьте фактический argv и рабочий каталог.

## Примеры

```bash
llama-server --model /models/model.gguf --grammar-file /srv/llama/grammars/yes-no.gbnf
```

Пример содержимого файла:

```text
root ::= "yes" | "no"
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--grammar-file` и helper `read_file`.
- `llama.cpp/common/common.h`: `COMMON_GRAMMAR_TYPE_USER`.
- `llama.cpp/common/sampling.cpp`: создание grammar sampler.
- `llama.cpp/tools/server/README.md`: CLI help и invalid grammar response.
- `llama.cpp/common/preset.cpp`: sampling args в presets.
