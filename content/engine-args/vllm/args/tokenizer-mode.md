---
schema: 1
engine: vllm
primaryName: "--tokenizer-mode"
title: "--tokenizer-mode"
summary: Какой класс токенизатора и какой рендерер чата использовать. `auto` сам переключается на нужный режим по архитектуре модели и по признакам Mistral-репозитория; вручную задают почти только `slow` и `mistral`.
group: ModelConfig
related:
  - --tokenizer
  - --tokenizer-revision
  - --skip-tokenizer-init
  - --trust-remote-code
  - --model-impl
  - --renderer-num-workers
---

# --tokenizer-mode

## Кратко

`--tokenizer-mode` выбирает реализацию токенизатора из реестра `vllm/tokenizers/registry.py`, а для нескольких режимов — еще и способ рендеринга chat-шаблона (Kimi K3, Cohere, Inkling используют не Jinja).

В подавляющем большинстве случаев значение `auto` правильное: движок сам переключается на специальный режим по резолвнутой архитектуре и по содержимому репозитория.

## Оригинальная справка

```text
Tokenizer mode:

- "auto" will use the tokenizer from `mistral_common` for Mistral models
  if available, otherwise it will use the "hf" tokenizer.
- "hf" will use the fast tokenizer if available.
- "slow" will always use the slow tokenizer.
- "mistral" will always use the tokenizer from `mistral_common`.
- "deepseek_v32" will always use the tokenizer from `deepseek_v32`.
- "deepseek_v4" will always use the tokenizer from `deepseek_v4`.
- "kimi_k3" will always use the "hf" tokenizer but render chat prompts
  with Kimi K3's Python XTML encoding instead of a Jinja template.
- "cohere" uses the standard HF tokenizer but renders the chat template
  via the `cohere_melody` library (cmd3 / cmd4 templates) instead of
  Jinja, and surfaces grounded-citation metadata on responses.
- Other custom values can be supported via plugins.

To swap the Rust BPE backend that powers HF fast tokenizers for the
[fastokens](https://github.com/crusoecloud/fastokens) implementation, set
`VLLM_USE_FASTOKENS=1` instead — that override applies to any mode that
loads an HF fast tokenizer (`hf`, `deepseek_v32`, `deepseek_v4`, …).
```

## Паспорт аргумента

- Флаги: `--tokenizer-mode`
- Группа argparse: `ModelConfig`
- Тип значения: str; приводится к нижнему регистру валидатором `_lowercase_tokenizer_mode`
- Допустимые значения: **парсер не ограничивает**. Поле объявлено как `TokenizerMode | str`, поэтому `literal_to_kwargs` выдает `metavar`, а не `choices`, — argparse примет любую строку. Настоящий контракт — реестр `TokenizerRegistry` (`vllm/tokenizers/registry.py`): встроенные режимы `auto`, `hf`, `slow`, `mistral`, `deepseek_v32`, `deepseek_v4`, `kimi_k3`, `kimi_audio`, `inkling`, `cohere`; плагин может добавить свой через `TokenizerRegistry.register(...)`. Режим `inkling` присутствует в перечне значений, но в тексте оригинальной справки не описан
- Значение по умолчанию: `auto`
- Эффективное значение: переопределяется дважды. Сначала `ModelConfig.__post_init__` заменяет `auto` на специальный режим по архитектуре: `MoonshotKimiaForCausalLM` → `kimi_audio`, `KimiK3ForConditionalGeneration` → `kimi_k3`, `DeepseekV32ForCausalLM` → `deepseek_v32`, `DeepseekV4ForCausalLM` → `deepseek_v4`, `Inkling*` → `inkling`, а при `--model-impl terratorch` → `terratorch`; в лог идет `Defaulting to tokenizer_mode=<режим> for <Arch>`. Затем `resolve_tokenizer_args` доразрешает остаток: `slow` → `hf` с `use_fast=False`, `auto` → `mistral`, если репозиторий распознан как Mistral и содержит `tekken.json`/`tokenizer.model.v*`, иначе `auto` → `hf`
- Где объявлен: `vllm/config/model.py:ModelConfig.tokenizer_mode`
- Этап применения: сборка `ModelConfig` (подстановка по архитектуре) → загрузка токенизатора во фронтенде → выбор рендерера чата

## Что меняет в движке

Реестр `_VLLM_TOKENIZERS` сопоставляет режиму пару «модуль, класс»:

- `hf`, `slow`, `kimi_k3`, `inkling`, `cohere` → `CachedHfTokenizer`. Для трех последних отличается не токенизатор, а рендерер: Kimi K3 рендерит промпт своим Python-кодировщиком XTML, Cohere — через `cohere_melody` (шаблоны cmd3/cmd4) и добавляет метаданные цитирования, Inkling рендерит чат сразу в id, потому что Jinja-шаблона у модели нет.
- `mistral` → `MistralTokenizer` (`mistral_common`).
- `deepseek_v32`, `deepseek_v4` → собственные классы DeepSeek.
- `kimi_audio` → `KimiAudioTokenizer`.

`slow` дополнительно проверяет конфликт: если одновременно передан `use_fast=True`, поднимается `Cannot use the fast tokenizer in slow tokenizer mode.`

Отдельно: некоторые `model_type` (`internlm2`, `step3_vl`, `step3p7`, `unlimited-ocr`) объявляют на Hub неверный `tokenizer_class`, и для них vLLM принудительно подставляет generic-быстрый бэкенд, минуя `AutoTokenizer`.

Смена Rust-реализации BPE под HF-быстрыми токенизаторами (`fastokens`) — это **не** режим, а переменная окружения `VLLM_USE_FASTOKENS=1`, применяющаяся к любому режиму, который грузит HF fast tokenizer.

## Значения и формат

- `auto` — рекомендованное значение; разрешается по архитектуре и по содержимому репозитория (см. «Эффективное значение»).
- `hf` — принудительно HF-токенизатор, быстрый, если он доступен.
- `slow` — HF-токенизатор с `use_fast=False`. Дает эталонное поведение Python-реализации ценой скорости.
- `mistral` — токенизатор `mistral_common`; нужен, если автодетект не сработал (например, репозиторий выложен нестандартно).
- `deepseek_v32`, `deepseek_v4`, `kimi_k3`, `inkling`, `cohere` — режимы конкретных семейств; обычно ставятся движком автоматически.
- Произвольная строка проходит парсер и падает уже в реестре: `No tokenizer registered for tokenizer_mode='xxx'.`

## Когда использовать

- `slow` — для сверки токенизации при расследовании расхождений; в продакшене не оставляют.
- `mistral` — когда модель Mistral, а `auto` не переключился (репозиторий без `tekken.json`/`tokenizer.model.v*` или с непривычной структурой).
- Явный режим семейства (`deepseek_v32` и подобные) — когда архитектура резолвится не в то имя, на которое настроен автодетект.
- Не задавайте `hf` «для определенности» на моделях DeepSeek/Kimi/Inkling: вы отключите специализированный рендерер чата и получите другой промпт.

## Влияние на производительность и память

- **Latency фронтенда.** `slow` — самый дорогой вариант: чистый Python вместо нативной реализации. На длинных промптах разница видна в TTFT.
- **RAM хоста.** `CachedHfTokenizer` в связке с `--renderer-num-workers > 1` размножается в пул глубоких копий; медленный токенизатор в пул не заворачивается (`maybe_make_thread_pool` работает только для `TokenizersBackend`), то есть параллелизм рендерера ему не помогает.
- **VRAM.** Не влияет.
- **Качество промпта.** Режим определяет рендеринг chat-шаблона для нескольких семейств — это влияет на ответы модели сильнее, чем на скорость.

## Взаимодействие с другими аргументами

- `--tokenizer`: путь, к которому применяется режим.
- `--tokenizer-revision`: ревизия того же репозитория; участвует в автодетекте Mistral (проверка файлов делается для конкретной ревизии).
- `--skip-tokenizer-init`: токенизатор не поднимается вовсе, режим не используется.
- `--trust-remote-code`: нужен, если класс токенизатора приходит из репозитория.
- `--model-impl terratorch`: принудительно ставит `tokenizer_mode=terratorch`, которого нет среди встроенных режимов — его должна регистрировать интеграция TerraTorch.
- `--renderer-num-workers`: параллелизм вызовов токенизатора во фронтенде.

## Типовые проблемы и диагностика

- **Симптом:** `No tokenizer registered for tokenizer_mode='xxx'.` **Причина:** опечатка или режим, поставляемый плагином, который не загружен. **Лечение:** исправить имя либо установить плагин.
- **Симптом:** `Cannot use the fast tokenizer in slow tokenizer mode.` **Причина:** `slow` вместе с явным `use_fast=True`. **Лечение:** оставить одно из двух.
- **Симптом:** `Using a slow tokenizer. This might cause a significant slowdown. Consider using a fast tokenizer instead.` **Причина:** быстрый токенизатор недоступен либо режим `slow`. **Лечение:** источник с `tokenizer.json`.
- **Симптом:** задан `auto`, а в логе `Defaulting to tokenizer_mode='deepseek_v32' for DeepseekV32ForCausalLM`. **Причина:** штатная подстановка по архитектуре. **Действий не требуется.**
- **Симптом:** промпт чата собирается не так, как ожидалось, хотя токенизация корректна. **Причина:** для этого семейства рендерер задается режимом, а не Jinja-шаблоном. **Проверка:** `_VLLM_TOKENIZERS` и класс рендерера в `vllm/renderers/`.

## Примеры

```bash
vllm serve /models/Mistral-Small --tokenizer-mode mistral --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --tokenizer-mode slow --renderer-num-workers 1
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/tokenizers/registry.py`
- `vllm/vllm/tokenizers/hf.py`
- `vllm/vllm/renderers/hf.py`
- `vllm/vllm/engine/arg_utils.py`
