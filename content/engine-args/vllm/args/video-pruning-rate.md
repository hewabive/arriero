---
schema: 1
engine: vllm
primaryName: "--video-pruning-rate"
title: "--video-pruning-rate"
summary: Доля видео-токенов, выбрасываемых после энкодера. Единственный флаг, который сокращает длину промпта от видео, не трогая число кадров; работает только на моделях, реализовавших интерфейс мультимодального прунинга.
group: MultiModalConfig
related:
  - --video-pruning-method
  - --media-io-kwargs
  - --limit-mm-per-prompt
  - --max-model-len
  - --gpu-memory-utilization
  - --compilation-config
---

# --video-pruning-rate

## Кратко

Видео даёт тысячи визуальных токенов, и они занимают KV-cache и контекст наравне с текстом. Прунинг выкидывает часть уже посчитанных эмбеддингов перед их вклейкой в промпт: `0.5` означает «оставить примерно половину».

Флаг — включатель: прунинг активен, когда значение задано и больше нуля (`get_video_pruning_spec()` возвращает `None` иначе). Алгоритм выбирается отдельным `--video-pruning-method`.

Поддержка модель-специфична. Если архитектура не реализует протокол `SupportsMultiModalPruning`, значение просто не читается — ошибки не будет, эффекта тоже.

## Оригинальная справка

```text
Fraction of video tokens to prune from each video. Value sits in range
[0;1); pruning is enabled when it is greater than 0. The pruning algorithm
is selected by `video_pruning_method`.
```

## Паспорт аргумента

- Флаги: `--video-pruning-rate`
- Группа argparse: `MultiModalConfig`
- Тип значения: float (доля, не проценты), допустим `None`
- Допустимые значения: `Field(default=None, ge=0.0, lt=1.0)` — от `0.0` включительно до `1.0` исключительно
- Значение по умолчанию: `None` — прунинг выключен
- Эффективное значение: не переопределяется; несовместимая пара «метод + модель» роняет старт, а модель без поддержки прунинга значение игнорирует
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.video_pruning_rate`
- Этап применения: построение модели (флаг `is_multimodal_pruning_enabled`) → forward энкодера (`embed_multimodal`) → пересчёт M-RoPE позиций → вклейка эмбеддингов

## Что меняет в движке

**Включатель.** `MultiModalConfig.get_video_pruning_spec()` возвращает `(метод, rate)` только при `video_pruning_rate is not None and > 0`; `is_multimodal_pruning_enabled()` — обёртка над ним. Модели читают это при инициализации (`self.is_multimodal_pruning_enabled = multimodal_config.is_multimodal_pruning_enabled()`).

**Отбор токенов.** В `embed_multimodal` модель после обычного прогона ViT вызывает постпроцессинг: `compute_retention_mask(...)` считает маску сохраняемых токенов, а количество — `compute_retained_tokens_count(tokens_per_frame, num_frames, q)`. Формулы разные у двух методов:

- EVS (`vllm/multimodal/video_prune/evs.py`): `max(tokens_per_frame, int(total × (1 − q)))` — первый кадр сохраняется целиком при любом `q`;
- VidCom2 (`vllm/multimodal/video_prune/vidcom2.py`): `max(num_frames, min(int(total × (1 − q)), total))` — минимум один токен на кадр.

**Пересчёт позиций.** Число токенов после прунинга переменное, поэтому M-RoPE позиции нельзя посчитать заранее. Модели дописывают позиционные каналы к эмбеддингам, а `MultiModalPruner` (`vllm/v1/worker/gpu/model_states/mm_pruning.py`) отрезает их и пересчитывает позиции до слияния с текстовыми эмбеддингами. У Qwen2.5-VL это же требует наличия `second_per_grid_ts` во входе: `second_per_grid_ts is required when video_pruning_rate > 0 is enabled for video inputs, including the video_embeds path.`

**Валидация метода.** `ModelConfig.__post_init__` после создания `multimodal_config` сверяет выбранный метод со списком `supported_video_pruning_methods` модели: `Video pruning method '<method>' is not supported by <Architecture> (supported methods: (...)).` Список пуст у моделей без протокола — тогда проверка не выполняется вовсе.

**CUDA graphs энкодера.** У Qwen2.5-VL и Qwen3-VL включённый прунинг отключает CUDA graphs энкодера для всех модальностей: постпроцессинг эмбеддингов идёт мимо graph-пути, и форматы разошлись бы.

## Значения и формат

- Не задан (`None`) — прунинг выключен. Дефолт.
- `0.0` — формально допустимо, но эквивалентно выключенному: спецификация возвращает `None`.
- `0 < rate < 1` — доля выбрасываемых токенов. `0.75` оставляет примерно четверть.
- `1.0` и больше отвергает pydantic (`lt=1.0`); отрицательные — тоже (`ge=0.0`).
- Гарантированный минимум сохранённого зависит от метода: EVS никогда не выбрасывает первый кадр целиком, VidCom2 держит минимум один токен на кадр. Поэтому фактическая доля при больших `rate` оказывается выше запрошенной.
- Прунинг применяется к видео. У поддерживающих моделей изображения проходят через тот же постпроцессинг, но только ради дописывания позиционных каналов, а не для выбрасывания токенов.

## Когда использовать

- Видео-нагрузка, где длина промпта упирается в `--max-model-len` или KV-cache: `0.5`–`0.75` кратно сокращают число видео-токенов при сохранении охвата по времени.
- Как альтернатива уменьшению `num_frames` в `--media-io-kwargs`: прунинг сохраняет временное разрешение (кадры всё ещё просмотрены энкодером) и режет пространственную избыточность, тогда как уменьшение числа кадров теряет события между ними.
- Не включайте на модели без поддержки: молчаливое отсутствие эффекта легко принять за работающую настройку. Проверьте `supported_video_pruning_methods` у своей архитектуры.
- Не включайте вместе с расчётом на CUDA graphs энкодера у Qwen-VL: они будут отключены.
- Не ждите экономии на энкодере: прунинг происходит **после** ViT, время энкодера не сокращается.

## Влияние на производительность и память

- **KV-cache.** Основной выигрыш: меньше визуальных токенов — короче промпт — меньше KV на запрос и выше `Maximum concurrency` при том же бюджете (см. `--gpu-memory-utilization`).
- **Prefill.** Пропорционально короче: языковая модель обрабатывает меньше токенов.
- **Энкодер.** Не ускоряется: ViT прогоняется по всем кадрам, отбор идёт по его выходу.
- **Дополнительная работа.** Расчёт маски удержания и пересчёт M-RoPE позиций — заметно дешевле сэкономленного prefill'а, но не бесплатно.
- **CUDA graphs.** У Qwen2.5-VL/Qwen3-VL графы энкодера отключаются, что частично съедает выигрыш на мелких входах.
- **Качество.** Прямой компромисс: чем выше `rate`, тем больше визуальной информации теряется. Подбирается замером на своей задаче.

## Взаимодействие с другими аргументами

- `--video-pruning-method`: выбирает алгоритм; действует только когда `rate > 0`.
- `--media-io-kwargs`: другой рычаг сокращения видео-токенов — через число кадров и разрешение. Их эффекты перемножаются.
- `--limit-mm-per-prompt`: ограничивает число видео на запрос; прунинг — объём токенов внутри одного видео.
- `--max-model-len`: то, во что упирается длина промпта с видео; прунинг — способ в него уложиться.
- `--gpu-memory-utilization`: бюджет, в котором живёт сэкономленный KV-cache.
- `--compilation-config`: `cudagraph_mm_encoder` теряет смысл на моделях, отключающих графы при прунинге.

## Типовые проблемы и диагностика

- **Симптом:** `Video pruning method 'vidcom2' is not supported by Qwen2_5_VLForConditionalGeneration (supported methods: ('evs',)).` **Причина:** метод не реализован этой архитектурой. **Лечение:** `--video-pruning-method evs`.
- **Симптом:** `second_per_grid_ts is required when video_pruning_rate > 0 is enabled for video inputs, including the video_embeds path.` **Причина:** вход видео не содержит временнóй метаданной, обязательной для пересчёта M-RoPE. **Лечение:** подавать видео штатным путём (не сырыми эмбеддингами без метаданных) либо выключить прунинг.
- **Симптом:** флаг задан, число токенов не изменилось. **Причина:** модель не реализует `SupportsMultiModalPruning`, значение никем не читается. **Проверка:** grep по `supported_video_pruning_methods` и `is_multimodal_pruning_enabled` для класса вашей модели.
- **Симптом:** ошибка валидации конфига при `--video-pruning-rate 1.0`. **Причина:** верхняя граница исключающая (`lt=1.0`). **Лечение:** значение строго меньше единицы.
- **Симптом:** после включения прунинга просели графы энкодера. **Причина:** намеренное отключение CUDA graphs при прунинге у Qwen-VL. **Действие:** ожидаемо.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `video_pruning_rate=...`; практическая проверка — число промпт-токенов на одинаковом видео до и после включения.

## Примеры

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --video-pruning-rate 0.5 --limit-mm-per-prompt '{"video": 1, "image": 0}' --max-model-len 32768
```

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --video-pruning-rate 0.75 --video-pruning-method vidcom2 --media-io-kwargs '{"video": {"num_frames": 64}}'
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/multimodal/video_prune/evs.py`
- `vllm/vllm/multimodal/video_prune/vidcom2.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/model_executor/models/qwen2_5_vl.py`
- `vllm/vllm/model_executor/models/qwen3_vl.py`
- `vllm/vllm/v1/worker/gpu/model_states/mm_pruning.py`
