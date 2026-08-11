---
schema: 1
engine: sglang
primaryName: "--enable-custom-logit-processor"
title: "--enable-custom-logit-processor"
summary: Разрешает клиенту прислать в теле запроса сериализованный `dill`-объект, который сервер десериализует и выполнит над логитами. Это решение о доверии, а не настройка производительности: включение флага даёт любому, кто дотянулся до порта, выполнение произвольного кода в процессе scheduler'а.
group: exec.features
related:
  - --api-key
  - --admin-api-key
  - --host
  - --grammar-backend
  - --speculative-algorithm
  - --enable-return-hidden-states
---

# --enable-custom-logit-processor

## Кратко

Поле `custom_logit_processor` в запросе — это JSON со строкой `{"callable": "<hex-дамп dill>"}`. Сервер разбирает hex, отдает байты в `dill.loads` и вызывает полученный объект на каждой итерации сэмплинга. Никакой песочницы, ограничений на импорт или whitelist'а классов нет: `dill` — надстройка над `pickle`, а десериализация pickle из недоверенного источника — это выполнение произвольного кода. По умолчанию флаг выключен, и собственная справка SGLang говорит об этом прямо: «disabled by default for security». Без флага любой запрос с этим полем отвергается `ValueError` еще в tokenizer manager.

## Оригинальная справка

```text
Enable users to pass custom logit processors to the server (disabled by default for security)
```

## Паспорт аргумента

- Флаги: `--enable-custom-logit-processor`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным — ни один `_handle_*` и ни одно правило `arg_groups/overrides.py` его не переписывают
- Где объявлен: `ServerArgs.enable_custom_logit_processor`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → валидация запроса в `TokenizerManager` → сборка `SamplingBatchInfo` в scheduler'е → каждый шаг сэмплинга

## Что меняет в движке

### Ворота на входе

`TokenizerManager._validate_one_request` (`managers/tokenizer_manager.py`):

```python
if obj.custom_logit_processor and not self.server_args.enable_custom_logit_processor:
    raise ValueError("The server is not configured to enable custom logit processor. "
                     "Please set `--enable-custom-logit-processor` to enable this feature.")
```

Это единственная проверка. Она — про флаг, а не про содержимое: никакой валидации переданного объекта не выполняется ни до, ни после десериализации.

### Десериализация и выполнение

`SamplingBatchInfo.from_schedule_batch` (`sampling/sampling_batch_info.py`) группирует запросы по одинаковой строке процессора и для каждой уникальной строки вызывает `CustomLogitProcessor.from_str(processor_str)`. Внутри (`sampling/custom_logit_processor.py`):

```python
@lru_cache(maxsize=None)
def _cache_from_str(json_str: str):
    data = orjson.loads(json_str)
    return dill.loads(bytes.fromhex(data["callable"]))
```

Дальше `apply_custom_logit_processor` (`layers/sampler.py`) вызывает объект прямо перед сэмплингом, передавая ему срез логитов и список `custom_params` из запроса, и записывает результат обратно **на месте**.

Два практических следствия помимо RCE:

- `lru_cache(maxsize=None)` не ограничен: каждая новая уникальная строка процессора остается в памяти процесса навсегда. Поток запросов с разными процессорами — это утечка, управляемая клиентом.
- Процессор исполняется в процессе scheduler'а, то есть на горячем пути. Медленный или зависший Python-код в нем блокирует **всю** очередь этого ранга, а не только свой запрос; сработает watchdog.

### Что меняется в поведении батча

Наличие процессора помечает батч флагом `has_custom_logit_processor`, который переносится при слиянии и фильтрации батчей и отключает часть быстрых путей сэмплинга (например, на MLX-бэкенде батч с процессором исключается из ускоренной ветки, как и батч с грамматикой).

### Как это выглядит с точки зрения клиента

Поле объявлено и в нативном `/generate`, и в OpenAI-совместимых схемах: `CompletionRequest.custom_logit_processor` и `ChatCompletionRequest.custom_logit_processor` (`entrypoints/openai/protocol.py`). То есть достаточно обычного OpenAI-клиента с `extra_body`, отдельного «нативного» API не требуется.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Формат поля запроса: JSON-строка `{"callable": "<hex>"}`, где hex — `dill.dumps` класса-наследника `CustomLogitProcessor`. Строка получается из `MyProcessor.to_str()`.
- Параметры процессора передаются отдельно, в `sampling_params.custom_params`, и приходят в вызов списком по индексам батча.
- Ограничений на размер строки, на число уникальных процессоров и на время их выполнения нет.

## Когда использовать

- Локальный исследовательский сервер на `127.0.0.1`, где клиент и сервер — это вы: кастомные ограничения на словарь, бюджет размышления, экспериментальные схемы сэмплинга. Встроенные примеры — `DisallowedTokensLogitsProcessor` и `ThinkingBudgetLogitProcessor` в `sampling/custom_logit_processor.py`.
- Никогда — на сервере, слушающем не только loopback, без обязательного ключа. Комбинация `--host 0.0.0.0` + `--enable-custom-logit-processor` без `--api-key`/`--admin-api-key` эквивалентна открытому шеллу на хосте с вашими GPU и весами.
- Не используйте флаг для задач, которые решаются штатно: ограничение формата — это `--grammar-backend` и `json_schema`/`regex`/`ebnf` в запросе, запрет токенов — `logit_bias`, бюджет рассуждений — `reasoning_effort`.
- Не включайте на инстансе, где важна предсказуемая latency: чужой Python в цикле сэмплинга ее не гарантирует.

## Влияние на производительность и память

- **Latency.** Растет на батчах с процессором: Python-вызов на каждом шаге декодирования плюс маскирование и запись среза логитов. Величина полностью определяется присланным кодом.
- **RAM.** Неограниченный `lru_cache` десериализованных объектов; плюс всё, что аллоцирует сам процессор.
- **VRAM.** Прямо не растет, но процессор работает с тензором логитов и может выделять свои — это память в процессе scheduler'а.
- **Throughput.** Батч с процессором теряет часть быстрых путей сэмплинга.
- **Без запросов с этим полем.** Оверхеда нет: проверка `has_custom_logit_processor` сначала смотрит на флаг, потом на запросы.

## Взаимодействие с другими аргументами

- `--api-key` / `--admin-api-key`: единственная защита. Без них `/generate` и `/v1/*` доступны без ключа.
- `--host`: определяет, кто вообще может послать запрос.
- `--grammar-backend`: штатная альтернатива для ограничения формата вывода.
- `--speculative-algorithm`: процессор применяется и на верификации спекуляции (`num_tokens_in_batch` больше 1), в том числе на путях DSPARK и dflash.
- `--enable-return-hidden-states`: другой флаг, расширяющий контракт запроса/ответа; на этот не влияет.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: The server is not configured to enable custom logit processor.` **Причина:** флаг выключен. **Решение:** осознанно включить и закрыть сервер ключом — либо переписать логику через штатные средства.
- **Симптом:** watchdog убивает сервер вскоре после запроса с процессором. **Причина:** процессор зациклился или слишком медленный; scheduler заблокирован. **Решение:** убрать процессор, проверить его отдельно.
- **Симптом:** RSS процессов scheduler'а растет от запроса к запросу. **Причина:** неограниченный кеш десериализованных процессоров.
- **Симптом:** ошибка распаковки (`UnpicklingError`, несовпадение версий `dill`/Python между клиентом и сервером). **Причина:** `dill`-дамп несовместим с окружением сервера. **Решение:** совместить версии; никакой обратной совместимости у формата нет.
- **Что смотреть:** итоговый дамп `server_args=` при старте — включен ли флаг; на уровне debug — строка `Custom logit processor <Class> is applied.`
- **В arriero:** прокси arriero пробрасывает тело запроса как есть — `forwardBody` в `apps/api/src/proxy/forwarder.ts` копирует все поля и заменяет только `model`. Значит `custom_logit_processor` от клиента дойдет до SGLang без изменений. При этом публичные фасады `/v1/*` **не** закрыты `requireAdmin`, а источники запросов по умолчанию работают в режиме `allowAnonymous: true` (`docs/API_PROXY_FOUNDATION.md`). Если вы включаете флаг на инстансе за прокси arriero — заведите source с ключом и выключите `allowAnonymous`, иначе периметром станет весь доступ к порту arriero.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --host 127.0.0.1 --enable-custom-logit-processor
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-custom-logit-processor --api-key secret --admin-api-key admin-secret
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/sampling/custom_logit_processor.py`
- `sglang/python/sglang/srt/sampling/sampling_batch_info.py`
- `sglang/python/sglang/srt/layers/sampler.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/utils/auth.py`
- arriero: `apps/api/src/proxy/forwarder.ts`, `docs/API_PROXY_FOUNDATION.md`
