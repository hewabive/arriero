---
schema: 1
engine: vllm
primaryName: "--limit-mm-per-prompt"
title: "--limit-mm-per-prompt"
summary: Потолок числа медиа-элементов каждой модальности в одном запросе и одновременно форма фиктивных данных, которыми профилируется энкодер. Лимит `0` не просто отклоняет запросы — соответствующая башня энкодера не грузится в память вообще.
group: MultiModalConfig
related:
  - --language-model-only
  - --enable-mm-embeds
  - --skip-mm-profiling
  - --gpu-memory-utilization
  - --max-model-len
  - --max-num-batched-tokens
  - --max-num-seqs
  - --media-io-kwargs
  - --mm-processor-kwargs
  - --disable-chunked-mm-input
---

# --limit-mm-per-prompt

## Кратко

Аргумент делает три разных вещи одним значением:

1. **Валидация запроса.** Больше `count` элементов модальности в одном промпте — `400` с текстом `At most N image(s) may be provided in one prompt.`
2. **Профилирование памяти.** Из тех же значений строится фиктивный батч, на котором мультимодальный энкодер прогоняется при старте; его пик активаций вычитается из бюджета до KV-cache.
3. **Загрузка весов.** Если все модальности одной башни энкодера имеют лимит `0`, веса этой башни **не инициализируются вообще** — это экономия VRAM на весах, а не только на активациях.

Дефолт (`{}`) означает 999 на каждую модальность, то есть фактически «сколько выдержит модель»: реальный потолок дополнительно режется тем, что объявила сама модель (`supported_mm_limits`).

## Оригинальная справка

```text
The maximum number of input items and options allowed per
prompt for each modality.

Defaults to 999 for each modality.

Legacy format (count only):
    {"image": 16, "video": 2}

Configurable format (with options):
    {"video": {"count": 1, "num_frames": 32, "width": 512, "height": 512},
    "image": {"count": 5, "width": 512, "height": 512}}

Mixed format (combining both):
    {"image": 16, "video": {"count": 1, "num_frames": 32, "width": 512,
    "height": 512}}
```

## Паспорт аргумента

- Флаги: `--limit-mm-per-prompt`
- Группа argparse: `MultiModalConfig`
- Тип значения: JSON-объект `{модальность: count}` либо `{модальность: {count, ...опции}}`
- Допустимые значения: ключи — имена модальностей модели (`image`, `video`, `audio` и модель-специфичные); `count` — целое `ge=0`; опции размера — целые `gt=0`
- Значение по умолчанию: `Field(default_factory=dict)`, то есть пустой словарь; отсутствующая модальность читается как `999`
- Эффективное значение: `min(ваш лимит, supported_mm_limits модели)` в `BaseProcessingInfo.allowed_mm_limits`; `--language-model-only` обнуляет все модальности поверх этого значения
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.limit_per_prompt`
- Этап применения: сборка `VllmConfig` → загрузка модели (пропуск башен) → профилирование и выделение KV-cache → планировщик (encoder cache) → HTTP-слой (валидация запроса)

## Что меняет в движке

**Нормализация.** Валидатор `_validate_limit_per_prompt` приводит целое к `{"count": N}` и подставляет типизированный класс опций по имени модальности: `image` → `ImageDummyOptions(count, width, height)`, `video` → `VideoDummyOptions(count, num_frames, width, height)`, `audio` → `AudioDummyOptions(count, length)`, остальные → `BaseDummyOptions(count)`. Первые три объявлены с `extra="forbid"`, поэтому неизвестный ключ (например `fps` для видео) — ошибка валидации конфига, а не молчаливое игнорирование.

**Чтение.** Всё, что спрашивает лимит, идёт через `MultiModalConfig.get_limit_per_prompt(modality)`: `999` для незаданной модальности, `0` при `--language-model-only`.

**Валидация запроса.** `BaseProcessingInfo.allowed_mm_limits` = `min(user_limit, supported_limit)` по каждой модальности. `validate_num_items` бьёт при превышении и добавляет подсказку `Set --limit-mm-per-prompt to increase this limit.` только когда упёрлись именно в ваш лимит, а не в потолок модели.

**Профилирование.** `MultiModalBudget` (`vllm/multimodal/encoder_budget.py`) собирает модальности с лимитом > 0 в `tower_modalities`, строит для них фиктивные входы с `mm_options=mm_config.limit_per_prompt` и считает:

- `max_items_per_prompt = max(1, min(лимит, max_model_len // токенов_на_элемент))`;
- `max_items_per_batch = max(1, min(encoder_budget // токенов_на_элемент, max_num_seqs × max_items_per_prompt))`.

`GPUModelRunner.profile_run()` затем реально прогоняет энкодер на `max_items_per_batch` элементах самой «тяжёлой» модальности. Строка в логе: `Encoder cache will be initialized with a budget of N tokens, and profiled with M <modality> items of the maximum feature size.`

**Пропуск весов.** `SupportsMultiModal._mark_tower_model` оборачивает инициализацию башни в `no_init_weights`, когда `all(get_limit_per_prompt(m) == 0 for m in modalities)`. Модули заменяются на `StageMissingLayer`, веса не читаются с диска и не занимают VRAM.

**Полное выключение мультимодальности.** Если все поддерживаемые модальности получили `0`, `MULTIMODAL_REGISTRY.supports_multimodal_inputs()` возвращает `False` (лог `All limits of multimodal modalities supported by the model are set to 0, running in text-only mode.`), и вместе с этим отключаются кэш процессора и мультимодальная ветка рендерера. Исключение — `--enable-mm-embeds`: тогда инфраструктура остаётся, чтобы принимать готовые эмбеддинги.

## Значения и формат

Две равнозначные записи, обе принимает `FlexibleArgumentParser`:

```bash
--limit-mm-per-prompt '{"image": 4, "video": 0}'
--limit-mm-per-prompt.image 4 --limit-mm-per-prompt.video 0
```

- `count: 0` — модальность запрещена; веса башни не грузятся.
- Отсутствующая в словаре модальность — `999`, не `0`.
- Опции размера (`width`, `height`, `num_frames`, `length`) влияют **только на профилирование**: они задают геометрию фиктивных данных, по которой считается пик активаций энкодера. На обработку реальных входов они не влияют — реальный кадр обрабатывается как есть. Апстрим-документация это оговаривает отдельно и предупреждает, что размер encoder cache этими подсказками тоже не ограничивается.
- Слишком большая подсказка размера обрезается движком до максимума, который модель принимает, иногда с предупреждением.
- Модальность, которой у модели нет, просто не участвует в расчётах: `allowed_mm_limits` строится по `supported_mm_limits` модели.

## Когда использовать

- **Задавайте явно на управляемом сервере.** Дефолт 999 заставляет профилирование строить максимально возможный батч энкодера, а планировщик — резервировать encoder cache под него; на VL-модели это разница в несколько гигабайт VRAM.
- Выключайте неиспользуемые модальности нулём: `--limit-mm-per-prompt '{"video": 0}'` на чисто картиночном сервисе экономит и веса видео-башни (если она отдельная), и профилировочный пик.
- Ставьте `image: 1`, если вы обслуживаете однокартиночные запросы: и валидация станет честной, и профилировочный батч сожмётся.
- Подсказки размера имеет смысл задавать, когда ваш реальный трафик заметно мельче модельного максимума (например, скриншоты 1280×720 при поддержке 4K): профилирование перестанет резервировать память под сценарий, которого у вас нет.
- Не используйте лимит как защиту от больших изображений: он ограничивает **число** элементов, а не их разрешение. Для этого — `--media-io-kwargs` и `--mm-processor-kwargs`.

## Влияние на производительность и память

- **VRAM (веса).** Нули по всем модальностям башни убирают её веса целиком.
- **VRAM (активации).** Пик энкодера в профилировании пропорционален `max_items_per_batch`, который растёт с лимитом. Всё, что съело профилирование, не достанется KV-cache — механика бюджета описана в `--gpu-memory-utilization`.
- **VRAM (encoder cache).** Размер encoder cache берётся из `SchedulerConfig.encoder_cache_size`, который равен `max_num_batched_tokens`, а не из этого аргумента; лимит влияет на него только косвенно, через `max_items_per_batch` в профилировании.
- **RAM хоста.** Не меняется напрямую; на объём кэша процессора влияет `--mm-processor-cache-gb`.
- **Время старта.** Больший лимит — более тяжёлый профилировочный прогон энкодера. На больших ViT это заметные секунды.
- **Latency/throughput.** Сам лимит ничего не ускоряет; он ограничивает худший случай, который планировщику приходится закладывать.
- **LoRA.** `max_batches` для мультимодальных LoRA-слоёв считается как `max_num_seqs × max(лимит по модальностям)` — завышенный лимит раздувает LoRA-буферы.

## Взаимодействие с другими аргументами

- `--language-model-only`: жёстко перебивает всё — `get_limit_per_prompt` возвращает `0` для любой модальности, каким бы ни был словарь.
- `--enable-mm-embeds`: при лимите `0` разрешает подавать **готовые эмбеддинги** этой модальности мимо энкодера; счётная валидация для них пропускается, лимиты > 0 продолжают действовать.
- `--skip-mm-profiling`: отключает прогон энкодера, из-за чего значения лимита перестают влиять на измеренный пик — ответственность за VRAM переходит к вам.
- `--max-model-len`: участвует в `max_items_per_prompt` — на коротком контексте лимит фактически урезается тем, сколько placeholder-токенов помещается в промпт.
- `--max-num-batched-tokens`: задаёт `encoder_compute_budget` и `encoder_cache_size`, то есть верхнюю границу `max_items_per_batch`.
- `--max-num-seqs`: второй множитель в `max_items_per_batch`.
- `--gpu-memory-utilization`: общий бюджет, из которого вычитается всё измеренное профилированием.
- `--media-io-kwargs`, `--mm-processor-kwargs`: управляют тем, как выглядит **реальный** вход (число кадров, разрешение), тогда как опции размера здесь — только фиктивным.
- `--disable-chunked-mm-input`: меняет, как планировщик режет prefill с медиа, но не число элементов.

## Типовые проблемы и диагностика

- **Симптом:** `At most 1 image(s) may be provided in one prompt.` **Причина:** запрос превысил ваш лимит. **Лечение:** поднять `count` для модальности; если сообщение пришло без подсказки `Set --limit-mm-per-prompt ...`, упёрлись в потолок самой модели, и флаг не поможет.
- **Симптом:** OOM или подозрительно маленький `GPU KV cache size` на VL-модели при дефолтных аргументах. **Причина:** профилирование построило батч из десятков элементов. **Проверка:** строка `Encoder cache will be initialized with a budget of N tokens, and profiled with M <modality> items of the maximum feature size.` **Лечение:** задать реальный лимит (`{"image": 2}`) и/или подсказки размера.
- **Симптом:** вход `image_embeds` отвергается с `You must set --enable-mm-embeds to input image_embeds`. **Причина:** это не про лимит — нужен отдельный флаг.
- **Симптом:** в логе `All limits of multimodal modalities supported by the model are set to 0, running in text-only mode.` **Причина:** обнулены все модальности. **Действие:** ожидаемо, если вы этого и хотели; иначе проверьте имена ключей — опечатка в имени модальности не даёт ошибки, она просто создаёт лишнюю запись.
- **Симптом:** `ValidationError` на старте с упоминанием неизвестного поля (`Extra inputs are not permitted`). **Причина:** в опциях модальности передан ключ, которого нет в `ImageDummyOptions`/`VideoDummyOptions`/`AudioDummyOptions`. **Лечение:** параметры декодирования медиа задаются через `--media-io-kwargs`, а не здесь.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `limit_per_prompt=...`; далее — уже упомянутая строка про encoder cache и обычные `Available KV cache memory` / `GPU KV cache size`.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --limit-mm-per-prompt '{"image": 2, "video": 0}' --gpu-memory-utilization 0.85 --max-model-len 16384
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --limit-mm-per-prompt '{"image": {"count": 4, "width": 1280, "height": 720}}' --max-num-seqs 8
```

```bash
vllm serve /models/gemma-3-27b-it --limit-mm-per-prompt.image 0 --gpu-memory-utilization 0.9
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/multimodal/encoder_budget.py`
- `vllm/vllm/multimodal/registry.py`
- `vllm/vllm/multimodal/processing/context.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/core/encoder_cache_manager.py`
- `vllm/vllm/config/scheduler.py`
- `vllm/docs/configuration/conserving_memory.md`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
