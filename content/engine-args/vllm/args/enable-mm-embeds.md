---
schema: 1
engine: vllm
primaryName: "--enable-mm-embeds"
title: "--enable-mm-embeds"
summary: Разрешает клиенту присылать готовые мультимодальные эмбеддинги вместо картинок и видео. Открывает путь «энкодер снаружи, vLLM только языковая часть», но принимает произвольный тензор от клиента — включать только для доверенных источников.
group: MultiModalConfig
related:
  - --limit-mm-per-prompt
  - --language-model-only
  - --enable-prompt-embeds
  - --skip-mm-profiling
  - --mm-encoder-only
  - --ec-transfer-config
  - --api-key
---

# --enable-mm-embeds

## Кратко

По умолчанию vLLM принимает только сырые медиа и сам прогоняет их через энкодер. С `--enable-mm-embeds` в запросе можно прислать уже посчитанный тензор эмбеддингов (`"type": "image_embeds"` и аналоги в chat-сообщении, `multi_modal_data` в Python-API).

Практический смысл — вынести энкодер из этого инстанса: поставить `--limit-mm-per-prompt` в 0 для модальности (веса башни не грузятся, VRAM экономится) и всё равно принимать её как вход. Обратная сторона прямо написана в справке: движок не проверяет форму тензора и может упасть.

Парный флаг — `--no-enable-mm-embeds`.

## Оригинальная справка

```text
If `True`, enables passing multimodal embeddings:
for `LLM` class, this refers to tensor inputs under `multi_modal_data`;
for the OpenAI-compatible server, this refers to chat messages with content
`"type": "*_embeds"`.

When enabled with `--limit-mm-per-prompt` set to 0 for a modality,
precomputed embeddings skip count validation for that modality, 
saving memory by not loading encoder modules while still enabling 
embeddings as an input. Limits greater than 0 still apply to embeddings.

WARNING: The vLLM engine may crash if incorrect shape of embeddings is passed.
Only enable this flag for trusted users!
```

## Паспорт аргумента

- Флаги: `--enable-mm-embeds`, `--no-enable-mm-embeds`
- Группа argparse: `MultiModalConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: `True` / `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.enable_mm_embeds`
- Этап применения: сборка `VllmConfig` → профилирование (embedding-only режим) → HTTP-слой (парсинг и валидация запроса) → препроцессор

## Что меняет в движке

**Приём входа.** `BaseProcessingInfo.parse_mm_data` при виде `EmbeddingItems`/`DictEmbeddingItems` без флага бросает `You must set --enable-mm-embeds to input <modality>_embeds`. С флагом эмбеддинги проходят, а если лимит модальности равен 0 — счётная валидация для них вообще пропускается (`Skipping count validation for modality '...' (embeddings with limit=0)` в debug-логе).

**HTTP-слой.** `MultiModalItemTracker` (`vllm/entrypoints/chat_utils.py`) обходит `validate_num_items` ровно при трёх одновременных условиях: флаг включён, лимит модальности равен 0, и исходное имя части заканчивается на `_embeds`.

**Мультимодальная инфраструктура.** `MULTIMODAL_REGISTRY.supports_multimodal_inputs()` обычно возвращает `False`, когда все лимиты нулевые; с `--enable-mm-embeds` она возвращает `True`, потому что процессор всё ещё нужен — чтобы разложить placeholder-токены под присланные эмбеддинги.

**Бюджет и профилирование.** `MultiModalBudget` делит модальности на две группы: `tower_modalities` (лимит > 0, идут через энкодер) и `embed_only_modalities` (лимит 0 при включённом флаге). Encoder budget считается по объединению обеих, потому что место в encoder cache под присланные эмбеддинги нужно всё равно. При старте это видно по строке `enable_mm_embeds is True; modalities handled as embedding-only: ('image',)`. Если tower-модальностей не осталось, `profile_run()` пишет `Skipping encoder profiling for embedding-only mode (all modality limits=0 with enable_mm_embeds=True).` — энкодер не прогоняется, но бюджет encoder cache уже посчитан.

**Проверка размера.** Единственная реальная защита — `InputProcessor`: если число эмбеддингов больше `mm_encoder_cache_size`, запрос отклоняется с сообщением про уменьшение входа. Формы тензора (число измерений, hidden size) движок не валидирует — отсюда предупреждение в справке.

## Значения и формат

- Флага нет — `False`: любой `*_embeds` во входе отвергается на препроцессинге.
- `--enable-mm-embeds` — `True`.
- `--no-enable-mm-embeds` — явный `False`.
- Флаг не отменяет лимиты: при `--limit-mm-per-prompt '{"image": 2}'` эмбеддинги считаются наравне с картинками и третий элемент будет отвергнут. Пропуск счётной валидации включается только при лимите ровно `0`.

## Когда использовать

- Разнесённая архитектура: отдельный сервис (или отдельный vLLM-инстанс с `--mm-encoder-only`) считает эмбеддинги, а этот инстанс держит только языковую часть. Тогда `--limit-mm-per-prompt '{"image": 0}' --enable-mm-embeds` даёт максимальную экономию VRAM.
- Кэширование эмбеддингов на стороне приложения: одна и та же картинка в длинном диалоге считается один раз клиентом.
- Не включайте на сервере, доступном шире localhost, без аутентификации: клиент фактически передаёт сырой тензор во внутренние слои модели, и справка прямо называет это условием доверия. Как минимум закройте инстанс `--api-key` и сетевыми правилами.
- Не включайте «на всякий случай»: пока `*_embeds` никто не шлёт, флаг ничего не даёт, а поверхность атаки расширяет.

## Влияние на производительность и память

- **VRAM (веса).** Сам флаг ничего не экономит. Экономия появляется в паре с нулевым лимитом: башня энкодера тогда не инициализируется.
- **VRAM (encoder cache).** Место под присланные эмбеддинги резервируется — `embed_only_modalities` участвуют в расчёте `encoder_cache_size`.
- **VRAM (активации).** Прогон энкодера при профилировании пропускается, если tower-модальностей не осталось; пик активаций энкодера из бюджета исчезает.
- **Время старта.** Немного короче в embedding-only режиме: нет профилировочного прогона энкодера.
- **Latency.** TTFT падает на стороне vLLM (энкодер не считается), но работа переезжает к клиенту; сетевой трафик растёт — эмбеддинги обычно тяжелее исходного JPEG.
- **RAM хоста.** Инфраструктура процессора остаётся, кэш процессора (`--mm-processor-cache-gb`) продолжает выделяться.

## Взаимодействие с другими аргументами

- `--limit-mm-per-prompt`: ключевая пара. `0` + этот флаг = embedding-only модальность без весов энкодера; значение > 0 сохраняет обычную счётную валидацию и для эмбеддингов.
- `--language-model-only`: обнуляет лимиты всех модальностей, но остаётся более грубым инструментом; для приёма эмбеддингов используйте точечные нули в `--limit-mm-per-prompt`.
- `--mm-encoder-only`: обратная половина той же схемы — инстанс, который считает эмбеддинги и не держит языковую модель.
- `--ec-transfer-config`: штатный способ передавать эмбеддинги между инстансами через EC-коннектор, без прокладывания тензоров через публичный API.
- `--enable-prompt-embeds`: соседняя, но отдельная возможность — присылать эмбеддинги **текстового** промпта.
- `--skip-mm-profiling`: в embedding-only режиме прогон энкодера и так пропускается, флаг избыточен.
- `--api-key`: минимальная защита при включённом приёме тензоров.

## Типовые проблемы и диагностика

- **Симптом:** `You must set --enable-mm-embeds to input image_embeds`. **Причина:** клиент прислал эмбеддинги на инстансе без флага. **Лечение:** включить флаг либо перевести клиента на сырое медиа.
- **Симптом:** запрос отклонён с сообщением о том, что число эмбеддингов превышает размер encoder cache. **Причина:** `num_embeds > mm_encoder_cache_size`. **Лечение:** уменьшить вход или поднять `--max-num-batched-tokens` (именно он задаёт `encoder_cache_size`).
- **Симптом:** движок падает или выдаёт мусор после запроса с эмбеддингами. **Причина:** форма/тип тензора не совпали с ожиданиями модели; проверок нет. **Лечение:** сверить hidden size и dtype с моделью-энкодером; это же и есть повод не открывать флаг наружу.
- **Симптом:** флаг включён, лимит 0, а веса энкодера всё равно в памяти. **Проверка:** ищите строку `enable_mm_embeds is True; modalities handled as embedding-only: (...)`. Если модальности в списке нет — лимит для неё не 0 либо архитектура не помечает башню как отдельный компонент.
- **Подтверждение принятого значения:** упомянутые строки `enable_mm_embeds is True; ...` и `Skipping encoder profiling for embedding-only mode ...` в стартовом логе.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --enable-mm-embeds --limit-mm-per-prompt '{"image": 0, "video": 0}' --gpu-memory-utilization 0.9
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --enable-mm-embeds --limit-mm-per-prompt '{"image": 4}' --api-key local-only-key
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/multimodal/encoder_budget.py`
- `vllm/vllm/multimodal/registry.py`
- `vllm/vllm/multimodal/processing/context.py`
- `vllm/vllm/entrypoints/chat_utils.py`
- `vllm/vllm/v1/engine/input_processor.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/docs/features/multimodal_inputs.md`
