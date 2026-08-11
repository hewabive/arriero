---
schema: 1
engine: vllm
primaryName: "--video-pruning-method"
title: "--video-pruning-method"
summary: Какой алгоритм выбрасывает видео-токены, когда прунинг включён через `--video-pruning-rate`. `evs` реализован везде, где прунинг вообще есть; `vidcom2` — только у Qwen3-VL, и неверная пара роняет старт.
group: MultiModalConfig
related:
  - --video-pruning-rate
  - --media-io-kwargs
  - --limit-mm-per-prompt
  - --max-model-len
---

# --video-pruning-method

## Кратко

Сам по себе флаг ничего не включает: прунинг активен только при `--video-pruning-rate > 0`. Здесь выбирается, **как** отбирать сохраняемые токены.

Отличие от большинства enum-аргументов vLLM: неподдерживаемое значение не откатывается к дефолту, а роняет старт с явным перечислением того, что модель умеет. Это удобно — молчаливого «настроил, но не работает» здесь не будет.

## Оригинальная справка

```text
Video token pruning algorithm applied when `video_pruning_rate` > 0:
- "evs": Efficient Video Sampling.
- "vidcom2": Video Compression Commander.
```

## Паспорт аргумента

- Флаги: `--video-pruning-method`
- Группа argparse: `MultiModalConfig`
- Тип значения: enum (строка)
- Допустимые значения: `evs`, `vidcom2` (`VideoPruningMethod`)
- Значение по умолчанию: `evs`
- Эффективное значение: не переопределяется; при `--video-pruning-rate` без значения или с нулём вообще не применяется. Реальный список для конкретной модели — её `supported_video_pruning_methods`
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.video_pruning_method`
- Этап применения: forward энкодера, постпроцессинг эмбеддингов видео

## Что меняет в движке

**Выбор реализации.** `MultiModalConfig.get_video_pruning_spec()` отдаёт пару `(метод, rate)`; модель по методу выбирает функции из соответствующего модуля:

- `evs` → `vllm/multimodal/video_prune/evs.py`. «Efficient Video Sampling»: `compute_retained_tokens_count = max(tokens_per_frame, int(total × (1 − q)))` — первый кадр гарантированно сохраняется целиком независимо от `q`;
- `vidcom2` → `vllm/multimodal/video_prune/vidcom2.py`. «Video Compression Commander» (Liu et al., EMNLP 2025), портирован из референсной реализации; `compute_retained_tokens_count = max(num_frames, min(int(total × (1 − q)), total))` — минимум один токен на кадр. Внутри используется многомасштабная гауссова оценка с набором bandwidth'ов и softmax-температурой, то есть бюджет распределяется между кадрами неравномерно, по «информативности».

`Qwen3VLForConditionalGeneration` выбирает функцию прямо по значению (`... if method == "vidcom2" else ...`).

**Проверка совместимости.** `ModelConfig.__post_init__` после создания `multimodal_config`:

```python
if pruning_spec is not None and supported_pruning and pruning_spec[0] not in supported_pruning:
    raise ValueError(f"Video pruning method '{...}' is not supported by {...} (supported methods: {...}).")
```

`supported_video_pruning_methods` объявлен в протоколе `SupportsMultiModalPruning` как `("evs",)` и переопределён на `("evs", "vidcom2")` в Qwen3-VL. У моделей без протокола атрибута нет, реестр подставляет пустой кортеж — и проверка пропускается (как и сам прунинг).

## Значения и формат

- `evs` — дефолт и общий знаменатель: доступен на любой модели, реализующей прунинг.
- `vidcom2` — в этом commit'е checkout'а объявлен только у Qwen3-VL. Список меняется от релиза к релизу; проверяйте `supported_video_pruning_methods` у нужной архитектуры в `vllm/model_executor/models/`.
- Значение проверяется argparse по `choices`; совместимость с моделью — уже валидацией конфига.
- Без `--video-pruning-rate` значение хранится в конфиге, но не используется.

## Когда использовать

- Оставляйте `evs`, если не проверяли альтернативу замером: он поддержан шире и предсказуемо сохраняет первый кадр целиком.
- Пробуйте `vidcom2` на Qwen3-VL с длинными видео, где содержание меняется неравномерно: он распределяет бюджет токенов между кадрами по информативности, а не равномерно.
- Не задавайте флаг без `--video-pruning-rate`: это ничего не включает и только запутывает конфигурацию.
- Не переносите значение между моделями не глядя: `vidcom2` на модели без поддержки — отказ при старте.

## Влияние на производительность и память

- **KV-cache и prefill.** Величину экономии задаёт `--video-pruning-rate`; метод определяет только **какие** токены останутся, а не сколько (с точностью до разных нижних границ: кадр целиком у EVS против одного токена на кадр у VidCom2).
- **Стоимость отбора.** VidCom2 считает многомасштабные оценки и softmax по кадрам — дороже, чем EVS. На фоне сэкономленного prefill'а разница обычно невелика, но на коротких видео может быть заметна.
- **VRAM.** Прямого расхода нет; косвенно — через число оставшихся токенов.
- **Качество.** Основной критерий выбора. Замеряется на своей задаче: разные методы теряют разную информацию при одном и том же `rate`.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--video-pruning-rate`: включатель. Без него метод не применяется.
- `--media-io-kwargs`: число кадров и разрешение определяют, из чего вообще отбирать; нижние границы обоих методов выражены в кадрах, поэтому число кадров задаёт минимально возможный результат.
- `--limit-mm-per-prompt`: сколько видео допустимо в запросе.
- `--max-model-len`: то, во что упирается длина промпта с видео.

## Типовые проблемы и диагностика

- **Симптом:** `Video pruning method 'vidcom2' is not supported by <Architecture> (supported methods: ('evs',)).` **Причина:** модель не реализует этот метод. **Лечение:** `evs`.
- **Симптом:** метод задан, а прунинга нет. **Причина:** не задан `--video-pruning-rate` либо он равен нулю. **Лечение:** задать положительное значение меньше единицы.
- **Симптом:** ни ошибки, ни эффекта. **Причина:** модель не реализует `SupportsMultiModalPruning`, проверка пропускается вместе с прунингом. **Проверка:** grep по `supported_video_pruning_methods` для класса модели.
- **Симптом:** при большом `rate` число токенов упало не так сильно, как ожидалось. **Причина:** нижняя граница метода — целый первый кадр у EVS, один токен на кадр у VidCom2.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `video_pruning_method=...`; отсутствие ошибки совместимости означает, что модель метод поддерживает.

## Примеры

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --video-pruning-method vidcom2 --video-pruning-rate 0.6 --limit-mm-per-prompt '{"video": 1}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --video-pruning-method evs --video-pruning-rate 0.5 --media-io-kwargs '{"video": {"num_frames": 32}}'
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/multimodal/video_prune/evs.py`
- `vllm/vllm/multimodal/video_prune/vidcom2.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/model_executor/models/qwen3_vl.py`
- `vllm/vllm/model_executor/models/registry.py`
