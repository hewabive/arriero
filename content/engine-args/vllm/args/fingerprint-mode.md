---
schema: 1
engine: vllm
primaryName: "--fingerprint-mode"
title: "--fingerprint-mode"
summary: Что кладется в поле `system_fingerprint` ответа: версия плюс степени параллелизма и хеш конфигурации, только хеш, произвольная строка или ничего.
group: Frontend
related:
  - --fingerprint-value
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --data-parallel-size
  - --enable-expert-parallel
---

# --fingerprint-mode

## Кратко

`system_fingerprint` — поле OpenAI-протокола, по которому клиент понимает, что серверная конфигурация изменилась и кэшировать прежние результаты нельзя. vLLM формирует его из версии, степеней параллелизма и восьмисимвольного префикса `VllmConfig.compute_hash()`.

Режим `full` (по умолчанию) раскрывает наружу и версию движка, и топологию параллелизма. Если это нежелательно, есть `hash`, `custom` и `none`.

## Оригинальная справка

```text
Controls the ``system_fingerprint`` field on responses.

- ``full`` (default): ``vllm-<version>[-<parallelism>]-<hash8>``. Encodes
  server version, non-trivial parallelism degrees (tp/pp/dp/ep), and an
  8-char config hash.
- ``hash``: ``vllm-<version>-<hash8>``. Parallelism stripped.
- ``custom``: emits the literal string from ``--fingerprint-value``.
- ``none``: the field is omitted (serialized as ``null``).
```

## Паспорт аргумента

- Флаги: `--fingerprint-mode`
- Группа argparse: `Frontend`
- Тип значения: enum (строка)
- Допустимые значения: `full`, `hash`, `custom`, `none`
- Значение по умолчанию: `full`
- Эффективное значение: вычисляется один раз при создании serving-классов и кэшируется в `self.system_fingerprint`; любое исключение при вычислении превращает результат в `None` — старт из-за отпечатка не падает
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.fingerprint_mode`
- Этап применения: инициализация состояния генеративного роутера (`set_default_fingerprint_mode`) → сборка каждого ответа

## Что меняет в движке

`init_generate_state` первым делом вызывает `set_default_fingerprint_mode(args.fingerprint_mode, args.fingerprint_value)` — до конструирования любого serving-класса. Каждый из них в базовом конструкторе один раз запрашивает `get_system_fingerprint(engine_client.vllm_config)` и запоминает строку.

`build_system_fingerprint` (`vllm/entrypoints/serve/utils/fingerprint.py`):

- `none` → `None`;
- `custom` → значение `--fingerprint-value` как есть (включая `None`, если оно не задано);
- иначе берется `vllm_config.compute_hash()[:8]`, а при исключении — литерал `nohash`;
- `hash` → `vllm-<version>-<hash8>`;
- `full` → к тому же добавляются `tp<N>`, `pp<N>`, `dp<N>` (только когда степень больше 1) и `ep` при включенном expert parallel: `vllm-0.x.y-tp2-ep-1a2b3c4d`.

`compute_hash()` `VllmConfig` собирается из версии vLLM и хешей конфигураций модели, кэша, параллелизма и планировщика — то есть отпечаток меняется при смене модели, квантизации, длины контекста и подобных параметров, влияющих на граф вычислений.

Куда попадает строка: в нестриминговые ответы чата и completions, в батч-обработчик, а в стриминге — на терминальный чанк (тот, у которого есть `finish_reason`) либо на финальный usage-чанк, если usage включен. Промежуточные чанки поле не несут.

## Значения и формат

- `full` — `vllm-<version>[-tpN][-ppN][-dpN][-ep]-<hash8>`. Степени, равные 1, опускаются.
- `hash` — `vllm-<version>-<hash8>`, без топологии.
- `custom` — ровно строка из `--fingerprint-value`. Если она не задана, поле окажется `null`, то есть режим выродится в `none`.
- `none` — поле отсутствует (сериализуется как `null`).
- Прочие значения отвергаются argparse'ом: список `choices` фиксирован.

## Когда использовать

- Оставьте `full`, если клиент кэширует ответы и должен замечать изменение конфигурации.
- `hash` — когда наружу не следует раскрывать топологию параллелизма, но нужно сохранить сигнал «конфигурация изменилась».
- `custom` — когда отпечаток должен быть стабильным идентификатором вашего развертывания (например, версией вашего сервиса, а не vLLM). Помните, что тогда он перестает меняться при смене модели.
- `none` — минимально разговорчивый ответ. Учтите, что версия vLLM всё равно доступна через `GET /version`.

## Влияние на производительность и память

Практически нулевое: строка вычисляется несколько раз за старт (по одному разу на serving-класс) и дальше только читается из атрибута. `compute_hash()` — единственная сколько-нибудь заметная работа, и она выполняется на старте.

## Взаимодействие с другими аргументами

- `--fingerprint-value`: обязателен по смыслу для режима `custom`; в остальных режимах игнорируется.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--data-parallel-size`, `--enable-expert-parallel`: их значения кодируются в отпечатке в режиме `full`.

## Типовые проблемы и диагностика

- **Симптом:** `system_fingerprint` равен `null` при режиме `custom`. **Причина:** не задан `--fingerprint-value`. **Лечение:** задать значение либо перейти на другой режим.
- **Симптом:** в отпечатке видно `nohash`. **Причина:** `compute_hash()` бросил исключение и был подставлен литерал. **Проверка:** сообщение об ошибке в логе старта, если оно есть. **Лечение:** отпечаток не критичен для работы; при повторяемости — сообщать апстриму с конфигурацией.
- **Симптом:** отпечаток отличается между инстансами с одинаковой моделью. **Причина:** различаются параметры, входящие в `compute_hash()` (длина контекста, квантизация, параллелизм) или версия vLLM. **Лечение:** сравнить конфигурации.
- **Симптом:** в стриминге поля нет. **Причина:** оно ставится только на последнем сообщении потока. **Лечение:** читать терминальный чанк или финальный usage-чанк.
- **Подтверждение принятого значения:** обычный нестриминговый запрос — поле `system_fingerprint` в ответе.

## Примеры

```bash
vllm serve /models/Qwen3-4B --fingerprint-mode hash --tensor-parallel-size 2
```

```bash
vllm serve /models/Qwen3-4B --fingerprint-mode custom --fingerprint-value prod-chat-2026-08
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/serve/utils/fingerprint.py`
- `vllm/vllm/entrypoints/generate/base/serving.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/config/vllm.py`
