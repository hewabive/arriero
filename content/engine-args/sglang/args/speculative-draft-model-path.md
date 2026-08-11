---
schema: 1
engine: sglang
primaryName: "--speculative-draft-model-path"
title: "--speculative-draft-model-path"
summary: Путь или HF repo id весов draft-модели для спекулятивного декодирования. Обязателен для EAGLE3, STANDALONE, DFLASH и обычного DSPARK; для MTP-чекпоинтов (DeepSeek, GLM-4 MoE, Bailing) подставляется автоматически из `--model-path`, а для NGRAM не нужен вовсе.
group: spec
related:
  - --speculative-algorithm
  - --speculative-draft-model-revision
  - --speculative-draft-model-quantization
  - --speculative-draft-load-format
  - --speculative-draft-attention-backend
  - --speculative-token-map
  - --decrypted-draft-config-file
  - --model-path
  - --revision
  - --trust-remote-code
  - --download-dir
  - --mem-fraction-static
---

# --speculative-draft-model-path

## Кратко

Второй набор весов, который сервер грузит в ту же карту. Путь читается не один раз: сначала из него достаётся hf-конфиг (проверка на Gemma4-архитектуру, block_size у DFLASH, gamma у DSPARK, число слоёв для расчёта KV-ячейки), потом по нему строится отдельный `TpModelWorker` с собственным `ModelRunner`, собственным attention-backend'ом и собственными CUDA graph'ами. Ошибка в пути валит старт до загрузки target-модели.

## Оригинальная справка

```text
The path of the draft model weights. This can be a local folder or a Hugging Face repo ID.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-model-path`, алиас `--speculative-draft-model`
- Группа: `spec`
- Тип значения: строка (`Optional[str]`) — локальный каталог, HF repo id или URI объектного хранилища
- Допустимые значения: не ограничены argparse; существование пути проверяет уже загрузчик
- Значение по умолчанию: `null`
- Эффективное значение: для EAGLE-семейства на архитектурах с MTP-головами (`DeepseekV3/V32/V4ForCausalLM`, `Glm4MoeForCausalLM`, `Glm4MoeLiteForCausalLM`, `GlmMoeDsaForCausalLM`, `BailingMoe*`, `MistralLarge3ForCausalLM`, `PixtralForConditionalGeneration`, `HYV3ForCausalLM`) подставляется `--model-path` вместе с `--revision`; для `DSPARK` то же самое происходит, если целевой чекпоинт несёт ключи `dspark_*`. При `SGLANG_USE_MODELSCOPE=1` путь дополнительно резолвится/скачивается через ModelScope
- Где объявлен: `ServerArgs.speculative_draft_model_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`handle_speculative_decoding` → `_handle_*`, `_handle_missing_default_values`, `_handle_model_source_paths`) → расчёт KV-пула → создание draft-воркера

## Что меняет в движке

Значение читают четыре независимых потребителя:

1. **Разрешение алиаса алгоритма.** `_resolve_speculative_algorithm_alias` грузит hf-конфиг по этому пути всегда, когда он задан — даже для `NGRAM`, которому draft не нужен. Если в `architectures` стоит `Gemma4AssistantForCausalLM`/`Gemma4UnifiedAssistantForCausalLM`, алгоритм `NEXTN`/`EAGLE` повышается до `FROZEN_KV_MTP`, а `EAGLE3` отвергается.
2. **Разрешение параметров алгоритма.** DFLASH берёт отсюда `block_size` (если не задан `--speculative-dflash-block-size`), DSPARK — `gamma`, `mask_token_id` и наличие confidence-головы.
3. **Расчёт KV-пула.** `spec_aux_hidden_state.py` строит `ModelConfig` draft'а и берёт из него число слоёв: для EAGLE/STANDALONE `cell_size` умножается на `1 + draft_layers / target_layers`, для DFLASH/DSPARK добавляется отдельно посчитанная ячейка draft'а. Для EAGLE3 оттуда же читаются `eagle_aux_hidden_state_layer_ids`.
4. **Загрузка весов.** `TpModelWorker(is_draft_worker=True)` создаёт `ModelConfig.from_server_args(..., is_draft_model=True)` с этим путём, `--speculative-draft-model-revision` и `--speculative-draft-model-quantization`; `--context-length` draft'а всегда берётся у target'а (draft работает в абсолютных позициях target'а).

Токенизатор для draft-воркера не создаётся вообще: `tokenizer_path` всегда указывает на target. Из этого следует практическое требование — словарь draft'а должен быть совместим с target'ом; расхождение проявится не сообщением о токенизаторе, а нулевым accept rate или падением в verify-ядре.

## Значения и формат

- Локальный каталог: должен существовать на момент старта на **каждом** узле, где поднимается воркер.
- HF repo id: скачивается стандартным путём huggingface_hub с учётом `--speculative-draft-model-revision` и `--download-dir`.
- URI объектного хранилища (RunAI): распознаётся `is_runai_obj_uri`, тогда `--speculative-draft-load-format` автоматически становится `runai_streamer`, а объект предзагружается в `_handle_model_source_paths`.
- Пустая строка не эквивалентна «не задан»: `_handle_missing_default_values` проверяет истинность значения, а `_handle_dflash`/`_handle_dspark` — `is None`, так что `""` пройдёт проверку обязательности и упадёт позже при загрузке конфига.
- Специальных значений (`auto`, `none`) нет.

## Когда использовать

- Всегда для `EAGLE3`, `STANDALONE`, `DFLASH` и DSPARK-чекпоинтов без встроенной draft-головы: без него старт падает с явным сообщением (`DFLASH speculative decoding requires setting --speculative-draft-model-path`, `DSpark dense speculative decoding requires setting --speculative-draft-model-path`).
- Для EAGLE на модели с MTP-головами — **не задавать**: движок подставит `--model-path` сам, а явное указание даст только предупреждение и лишнее чтение конфига.
- Задавать явно, если draft лежит рядом локально, а target скачивается из хаба (или наоборот): пути независимы.
- Не пытаться подставить сюда произвольную маленькую модель другого семейства ради `EAGLE`: EAGLE-драфтер обязан иметь совместимую с target'ом голову и словарь. Для «просто маленькой LLM» есть `STANDALONE`.

## Влияние на производительность и память

- VRAM: полные веса draft-модели плюс её KV-слои плюс её CUDA graph'ы. Для MTP-варианта это один-два дополнительных слоя того же чекпоинта, для STANDALONE — целая вторая модель.
- KV-пул: сжимается пропорционально `draft_layers / target_layers` (EAGLE/STANDALONE) или на величину draft-ячейки (DFLASH/DSPARK) — при том же `--mem-fraction-static` `max_total_num_tokens` становится меньше.
- RAM хоста и время старта: плюс скачивание/чтение второго чекпоинта и второй проход загрузчика весов.
- Throughput/latency: сам путь ни на что не влияет, влияет качество указанного draft'а — оно видно как `accept len` в строках `Decode batch`.

## Взаимодействие с другими аргументами

- `--speculative-algorithm`: определяет, обязателен ли путь и как трактуется чекпоинт.
- `--speculative-draft-model-revision`: при заданном пути и пустой ревизии подставляется `main`.
- `--speculative-draft-model-quantization` / `--speculative-draft-load-format`: как именно грузятся эти веса; без них наследуются `--quantization` и `--load-format` target'а.
- `--decrypted-draft-config-file`: подменяет файл конфигурации draft'а (аналог `--decrypted-config-file` для target'а) и используется уже на шаге разрешения алиаса алгоритма.
- `--trust-remote-code`: нужен, если конфиг/код draft-архитектуры кастомный, — иначе `get_config` упадёт ещё в `__post_init__`.
- `--speculative-token-map`: FR-Spec-таблица частотных токенов к этому же draft'у (только EAGLE-2).
- `--mem-fraction-static`: тот же бюджет теперь держит две модели.
- `--model-path` / `--revision`: источник значения по умолчанию для MTP-чекпоинтов.

## Типовые проблемы и диагностика

- `DFLASH speculative decoding requires setting --speculative-draft-model-path` / `DSpark dense speculative decoding requires setting --speculative-draft-model-path` — алгоритм выбран, draft не указан.
- `Gemma4AssistantForCausalLM draft requires --speculative-algorithm NEXTN or EAGLE; EAGLE3 is not supported for this draft architecture.` — несовместимая пара алгоритм/чекпоинт.
- `DeepSeek MTP does not require setting speculative_draft_model_path` — предупреждение: путь избыточен, уберите его.
- Ошибка `OSError`/`HFValidationError` из `get_config` в самом начале старта — путь не существует или требует `--trust-remote-code`; заметьте, что это происходит **до** загрузки target-весов.
- Старт прошёл, но `accept len` держится около 1.00 — draft не соответствует target'у (другая версия, другой словарь). Сверьте, что чекпоинты одной пары; для MTP уберите явный путь.
- Что смотреть в логе: дамп `server_args=` (какой путь реально принят, включая автоподстановку), строки загрузчика весов draft-воркера, у DFLASH — `Initialized DFLASH draft runner. attention_backend=…, model=…, block_size=…`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm DFLASH --speculative-draft-model-path z-lab/LLaMA3.1-8B-Instruct-DFlash-UltraChat --speculative-draft-model-revision main --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/spec_aux_hidden_state.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_config.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
