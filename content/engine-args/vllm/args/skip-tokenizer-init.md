---
schema: 1
engine: vllm
primaryName: "--skip-tokenizer-init"
title: "--skip-tokenizer-init"
summary: Полностью отключает загрузку токенизатора и детокенизатора: сервер принимает только `prompt_token_ids` и возвращает id токенов. Отключает вместе с этим structured outputs и текстовые эндпоинты.
group: ModelConfig
related:
  - --tokenizer
  - --tokenizer-mode
  - --tokens-only
  - --structured-outputs-config
  - --renderer-num-workers
  - --model
---

# --skip-tokenizer-init

## Кратко

`--skip-tokenizer-init` переводит инстанс в режим «токены на входе, токены на выходе». Токенизатор не загружается вовсе (`cached_tokenizer_from_config` возвращает `None`), поэтому любая операция, которой нужен текст, отказывает явной ошибкой, а не деградирует.

Это режим для конвейеров, где токенизация делается снаружи: бенчмарки, распределенные фронтенды, token-in/token-out сервисы.

## Оригинальная справка

```text
Skip initialization of tokenizer and detokenizer. Expects valid
`prompt_token_ids` and `None` for prompt from the input. The generated
output will contain token ids.
```

## Паспорт аргумента

- Флаги: `--skip-tokenizer-init`, `--no-skip-tokenizer-init`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: `false`
- Эффективное значение: принудительно включается, если задан `--tokens-only`; в лог идет `Skipping tokenizer initialization for tokens-only mode.` (`EngineArgs.create_engine_config`)
- Где объявлен: `vllm/config/model.py:ModelConfig.skip_tokenizer_init`
- Этап применения: сборка `VllmConfig` → инициализация рендерера и структурных выводов во фронтенде → обработка каждого запроса

## Что меняет в движке

1. **Токенизатор не создается.** `cached_tokenizer_from_config` (`vllm/tokenizers/registry.py`) сразу возвращает `None`, поэтому у рендерера нет объекта токенизатора.
2. **Текстовый вход запрещен.** Любая попытка передать текст дает явную ошибку: `You cannot pass text prompts when 'skip_tokenizer_init=True'` (мультимодальный контекст), `Tokenizer not available when 'skip_tokenizer_init=True'` (рендерер и chat-эндпоинт), `Cannot pad tokens when 'skip_tokenizer_init=True'` (подготовка параметров запроса). В completion-эндпоинте отказ приходит с полем `parameter="skip_tokenizer_init"`.
3. **Детокенизации нет.** Ответ содержит id токенов; текст движок не собирает.
4. **Structured outputs отключены.** `vllm/v1/structured_output/__init__.py` инициализирует подсистему только при `not skip_tokenizer_init`, а `SamplingParams` отвергает запрос с `Structured outputs requires a tokenizer so it can't be used with 'skip_tokenizer_init'`.
5. **Мультимодальный процессор** тоже теряет возможность кодировать/декодировать текст (`You cannot encode text when 'skip_tokenizer_init=True'`, `You cannot decode tokens when 'skip_tokenizer_init=True'`).

## Значения и формат

- Не задан — `false`, токенизатор поднимается штатно.
- `--skip-tokenizer-init` — включить.
- `--no-skip-tokenizer-init` — явно выключить; нужно, чтобы перебить значение из `--config file.yaml`.
- Промежуточных вариантов («грузить, но не детокенизировать») нет; за отключение детокенизации на уровне фронтенда отвечает `--tokens-only`.

## Когда использовать

- Конвейер, где токенизация уже сделана: клиент шлет `prompt_token_ids`, дальше сам декодирует id.
- Замер производительности движка без вклада токенизации и детокенизации.
- Не включайте на сервере общего назначения: chat- и completion-эндпоинты с текстом перестанут работать, а structured outputs станут недоступны.
- Не рассматривайте как способ экономии VRAM: токенизатор в видеопамяти не живет.

## Влияние на производительность и память

- **VRAM.** Не влияет.
- **RAM хоста.** Экономит объект токенизатора и, при `--renderer-num-workers > 1`, весь пул его копий.
- **Latency.** Убирает токенизацию промпта и инкрементальную детокенизацию из горячего пути фронтенда; на коротких ответах эффект небольшой, на длинных потоковых — заметный.
- **Время старта.** Пропускается загрузка файлов токенизатора (и сетевой запрос, если он удаленный).

## Взаимодействие с другими аргументами

- `--tokenizer`, `--tokenizer-mode`, `--tokenizer-revision`: при включенном флаге не используются.
- `--tokens-only`: включает этот флаг принудительно.
- `--structured-outputs-config`: несовместим — structured outputs требуют токенизатор.
- `--renderer-num-workers`: пул токенизаторов не создается, значение остается актуальным только для прочих задач рендерера.
- `--model`: словарь модели по-прежнему определяет допустимый диапазон id; проверка `logprob_token_ids` на выход за словарь работает и без токенизатора.

## Типовые проблемы и диагностика

- **Симптом:** `Tokenizer not available when 'skip_tokenizer_init=True'` на chat-запросе. **Причина:** режим включен, а клиент шлет текст. **Лечение:** слать `prompt_token_ids` либо выключить флаг.
- **Симптом:** `Structured outputs requires a tokenizer so it can't be used with 'skip_tokenizer_init'`. **Причина:** запрос с грамматикой/JSON-схемой. **Лечение:** выключить режим.
- **Симптом:** флаг не задавали, а токенизатор не поднялся. **Причина:** задан `--tokens-only`. **Проверка:** строка `Skipping tokenizer initialization for tokens-only mode.` в логе старта.
- **Симптом:** в ответах вместо текста числа. **Причина:** это и есть штатное поведение режима. **Лечение:** декодировать id на стороне клиента тем же токенизатором, что у модели.
- **Подтверждение принятого значения:** баннер конфигурации при старте содержит `skip_tokenizer_init=…` (`vllm/config/vllm.py`).

## Примеры

```bash
vllm serve /models/Qwen3-4B --skip-tokenizer-init --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --no-skip-tokenizer-init --tokenizer /models/Qwen3-4B
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/tokenizers/registry.py`
- `vllm/vllm/renderers/base.py`
- `vllm/vllm/sampling_params.py`
- `vllm/vllm/v1/structured_output/__init__.py`
- `vllm/vllm/multimodal/processing/processor.py`
