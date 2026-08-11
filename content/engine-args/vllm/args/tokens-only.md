---
schema: 1
engine: vllm
primaryName: "--tokens-only"
title: "--tokens-only"
summary: Режим «токены на входе — токены на выходе» для disaggregated-развертываний: отключает токенизатор, детокенизацию и добавляет `POST /abort_requests`. Обычные текстовые эндпоинты после этого неработоспособны.
group: Frontend
related:
  - --skip-tokenizer-init
  - --return-tokens-as-token-ids
  - --enable-prompt-tokens-details
  - --kv-transfer-config
---

# --tokens-only

## Кратко

Флаг рассчитан на схему, где токенизацию и детокенизацию выполняет отдельный процесс (render/derender), а этот сервер работает исключительно с идентификаторами токенов через `POST /inference/v1/generate`.

Название обещает «включить только один эндпоинт», но на этом commit'е ни один роутер не снимается. Эффект достигается иначе: движок поднимается без токенизатора, поэтому текстовые эндпоинты перестают быть пригодными.

## Оригинальная справка

```text
If set to True, only enable the Tokens In<>Out endpoint.
This is intended for use in a Disaggregated Everything setup.
```

## Паспорт аргумента

- Флаги: `--tokens-only`, `--no-tokens-only`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` или отсутствие обоих (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: одноименное поле есть и у `EngineArgs` (`vllm/engine/arg_utils.py`), CLI-флаг регистрируется только фронтендом, а движок читает то же значение из namespace; в `create_engine_config` оно принудительно выставляет `ModelConfig.skip_tokenizer_init = True`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.tokens_only`
- Этап применения: сборка `VllmConfig` (отключение токенизатора) → построение FastAPI-приложения (регистрация `/abort_requests`) → инициализация состояния (отключение детокенизации)

## Что меняет в движке

Три независимых эффекта.

1. **Токенизатор не инициализируется.** `EngineArgs.create_engine_config` выставляет `model_config.skip_tokenizer_init = True` и пишет в лог `Skipping tokenizer initialization for tokens-only mode.` Всё, что требует токенизатора, дальше отвечает ошибкой `Unable to get tokenizer because skip_tokenizer_init=True`.
2. **Детокенизация выключается.** `init_scale_out_state` создает `ServingTokens(force_no_detokenize=True)`; обработчик выставляет `sampling_params.detokenize = False` каждому запросу и один раз пишет `Tokens-only mode is enabled, skipping detokenization step for incoming requests.`
3. **Появляется `POST /abort_requests`.** Роут регистрируется в `attach_router` (`vllm/entrypoints/scale_out/token_in_token_out/api_router.py`) только при включенном флаге. Он принимает `{"request_ids": [...]}` и вызывает `engine_client.abort(...)` в фоновой задаче, отвечая 200 немедленно.

Сам эндпоинт `POST /inference/v1/generate` существует независимо от флага — он регистрируется, когда среди поддерживаемых задач есть `generate`.

## Значения и формат

- Включение: `--tokens-only`. Выключение: `--no-tokens-only`.
- «Не задан» = `false`.
- Специальных значений нет. Флаг не принимает список эндпоинтов и не выбирает, что именно оставить.
- Совместим с явным `--skip-tokenizer-init`: если тот уже включен, `create_engine_config` ничего не делает и лог-строку не печатает.

## Когда использовать

- Развертывание «disaggregated everything», где рендеринг промпта и детокенизация вынесены в отдельные процессы, а этот инстанс получает готовые `prompt_token_ids`.
- Prefill/decode-раздельные схемы с переносом токенов через `--kv-transfer-config`: сторона, которая не должна тратить CPU на текст.
- Не включайте на инстансе, который отдает OpenAI-совместимое API людям или обычным клиентам: `/v1/chat/completions` и `/v1/completions` начнут отвечать ошибками про отсутствующий токенизатор, и это выглядит как поломка сборки, а не как настройка.
- Не используйте ради экономии CPU на обычном сервере: экономия детокенизации не стоит потери текстового API.

## Влияние на производительность и память

- **RAM хоста и время старта.** Токенизатор не загружается — минус его инициализация и память под словарь. На больших словарях это заметно на старте, но не сравнимо с загрузкой весов.
- **CPU.** Отключенная детокенизация убирает работу на каждый выданный токен; при потоковой генерации это самый заметный выигрыш режима.
- **VRAM и KV-cache.** Не меняются: флаг не трогает ни профилирование, ни планировщик.
- **Ответ.** Клиент получает идентификаторы токенов; преобразование в текст — его задача либо задача derender-сервиса.

## Взаимодействие с другими аргументами

- `--skip-tokenizer-init`: флаг фактически включает его; задавать оба не требуется.
- `--return-tokens-as-token-ids`: при отсутствии токенизатора logprobs без него отвечают ошибкой, поэтому в этом режиме его обычно включают вместе.
- `--enable-prompt-tokens-details`: `ServingTokens` его поддерживает, поле `prompt_tokens_details` работает и здесь.
- `--kv-transfer-config`: типичный сосед в disaggregated-схеме, где этот инстанс — только одна из ступеней.

## Типовые проблемы и диагностика

- **Симптом:** `/v1/chat/completions` отвечает `Unable to get tokenizer because skip_tokenizer_init=True`. **Причина:** режим включен, текстовые эндпоинты в нем не работают. **Лечение:** снять флаг либо ходить в `POST /inference/v1/generate`.
- **Симптом:** `POST /abort_requests` отвечает 404. **Причина:** флаг не включен — роут регистрируется только вместе с ним. **Лечение:** включить `--tokens-only`.
- **Симптом:** `POST /abort_requests` отвечает 400 `Missing 'request_ids' in request body`. **Причина:** тело без обязательного ключа. **Лечение:** передать `{"request_ids": ["..."]}`.
- **Симптом:** `POST /inference/v1/generate` отвечает `The model does not support generate tokens API`. **Причина:** среди поддерживаемых задач нет `generate` (например, инстанс пулинговый). **Проверка:** `--runner`/`--convert` и список задач в логе старта. **Лечение:** запускать этот режим на генеративной модели.
- **Подтверждение принятого значения:** две строки лога — `Skipping tokenizer initialization for tokens-only mode.` и `Tokens-only mode is enabled, skipping detokenization step for incoming requests.`

## Примеры

```bash
vllm serve /models/Qwen3-4B --tokens-only --port 8100
```

```bash
vllm serve /models/Qwen3-4B --tokens-only --return-tokens-as-token-ids --max-model-len 8192
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/scale_out/factories.py`
- `vllm/vllm/entrypoints/scale_out/token_in_token_out/api_router.py`
- `vllm/vllm/entrypoints/scale_out/token_in_token_out/serving.py`
- `vllm/docs/serving/online_serving/README.md`
