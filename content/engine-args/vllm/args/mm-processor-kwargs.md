---
schema: 1
engine: vllm
primaryName: "--mm-processor-kwargs"
title: "--mm-processor-kwargs"
summary: Переопределения для HF-процессора модели (`AutoProcessor`) — число кропов, границы разрешения, модель-специфичные режимы. Набор ключей полностью зависит от модели, движок их не валидирует и передаёт как есть.
group: MultiModalConfig
related:
  - --media-io-kwargs
  - --limit-mm-per-prompt
  - --hf-overrides
  - --trust-remote-code
  - --mm-processor-cache-gb
---

# --mm-processor-kwargs

## Кратко

vLLM берёт процессор модели через `transformers.AutoProcessor.from_pretrained`. Всё, что вы положите в этот JSON, доедет до его конструктора и до каждого вызова — как обычные kwargs. Следствие: допустимые ключи задаёт **модель и версия transformers**, а не vLLM; в справке приведён пример `{"num_crops": 4}` для Phi-3-Vision.

Значения из этого словаря участвуют в вычислении `mm_hash`, поэтому смена kwargs корректно инвалидирует кэш препроцессинга.

## Оригинальная справка

```text
Arguments to be forwarded to the model's processor for multi-modal data,
e.g., image processor. Overrides for the multi-modal processor obtained
from `transformers.AutoProcessor.from_pretrained`.

The available overrides depend on the model that is being run.

For example, for Phi-3-Vision:
`{"num_crops": 4}`.
```

## Паспорт аргумента

- Флаги: `--mm-processor-kwargs`
- Группа argparse: `MultiModalConfig`
- Тип значения: JSON-объект (`dict[str, object] | None`)
- Допустимые значения: не ограничены движком; ключи проверяет уже HF-процессор
- Значение по умолчанию: `None`
- Эффективное значение: движок словарь не переопределяет; `merge_mm_processor_kwargs()` только сливает его с per-request kwargs, которые побеждают
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_processor_kwargs`
- Этап применения: создание процессора → каждый вызов HF-процессора → расчёт `mm_hash`

## Что меняет в движке

**Слияние.** `InputProcessingContext.get_merged_mm_kwargs()` вызывает `MultiModalConfig.merge_mm_processor_kwargs(inference_kwargs)`:

```python
kwargs = self.mm_processor_kwargs or {}
return kwargs | dict(inference_kwargs)
```

Порядок приоритета: engine-уровень → per-request kwargs (побеждают). Тот же словарь используется в `init_processor(...)` при построении процессора.

**Per-request.** Chat-completions и responses-протоколы принимают поле `mm_processor_kwargs` в теле запроса; оно сливается с engine-уровнем по правилу выше. Некоторые модели читают его напрямую — например `use_audio_in_video` разбирается в `chat_utils`.

**Кэширование.** `MultiModalHasher.hash_kwargs` включает `hf_processor_mm_kwargs` в хеш элемента, так что элементы, обработанные с разными kwargs, не путаются в кэше.

**Отсутствие валидации.** vLLM не сверяет ключи со списком поддерживаемых. Неизвестный ключ либо будет проигнорирован процессором, либо даст `TypeError` из transformers — в зависимости от того, как реализован конкретный процессор.

## Значения и формат

Две равнозначные записи:

```bash
--mm-processor-kwargs '{"num_crops": 4}'
--mm-processor-kwargs.num_crops 4
```

Для вложенных структур `FlexibleArgumentParser` поддерживает точечные под-флаги любой глубины, а для списков — тот же путь с суффиксом `+` в конце имени. Полная подсказка по обеим формам выводится в эпилоге `vllm serve --help`.

- `None` (не задан) — процессор строится с параметрами из конфига модели.
- Пустой объект `'{}'` эквивалентен отсутствию, но при этом создаёт словарь — на поведение это не влияет.
- Типичные ключи зависят от семейства: `num_crops` (Phi-3-Vision), границы числа пикселей у Qwen-VL-семейства, `use_audio_in_video` у omni-моделей. Единственный надёжный способ узнать список — сигнатура процессора в установленной версии transformers.

## Когда использовать

- Ограничить разрешение, с которым модель видит изображения: у Qwen-VL это самый прямой рычаг сокращения числа визуальных токенов, а значит и KV-cache, и времени prefill.
- Включить модель-специфичный режим (например обработку аудиодорожки видео), который иначе недоступен через CLI.
- Не используйте для параметров **загрузки** медиа (число кадров, кодек, fps) — это `--media-io-kwargs`. Разделение простое: `media-io` управляет тем, что попадёт в процессор, `processor-kwargs` — тем, что процессор с этим сделает.
- Не используйте для правки конфига модели: за это отвечает `--hf-overrides`.
- Помните, что per-request `mm_processor_kwargs` приходят от клиента и перебивают серверные значения. Если вы задаёте лимиты ради экономии памяти, полагаться на этот флаг как на защиту нельзя.

## Влияние на производительность и память

- **VRAM.** Через число визуальных токенов: параметры разрешения/кропов напрямую определяют размер выхода энкодера, размер занятого encoder cache и длину промпта. Это самый сильный рычаг из всех kwargs.
- **Профилирование.** Значения учитываются при построении фиктивных входов, поэтому измеренный пик активаций тоже меняется.
- **CPU хоста.** Более тяжёлый препроцессинг (много кропов) нагружает API-процесс.
- **Latency.** Прямая зависимость от количества сгенерированных визуальных токенов.
- **Кэш.** Изменение kwargs меняет `mm_hash`, то есть после правки кэш препроцессора холодный.

## Взаимодействие с другими аргументами

- `--media-io-kwargs`: соседний, но другой слой — декодирование медиа до процессора.
- `--limit-mm-per-prompt`: опции размера там влияют только на профилирование, тогда как эти kwargs влияют на реальную обработку.
- `--hf-overrides`: правит конфиг модели, а не процессор.
- `--trust-remote-code`: у моделей с кастомным процессором из репозитория без него kwargs просто некуда будет применить — процессор не загрузится.
- `--mm-processor-cache-gb`: кэш ключуется в том числе по этим kwargs.

## Типовые проблемы и диагностика

- **Симптом:** `TypeError: ... got an unexpected keyword argument 'num_crops'`. **Причина:** ключ не поддерживается процессором этой модели/версии transformers. **Лечение:** сверить с сигнатурой процессора; vLLM ключи не валидирует.
- **Симптом:** kwargs заданы, а поведение не изменилось. **Причина:** клиент присылает свои `mm_processor_kwargs`, которые применяются последними. **Проверка:** тело запроса.
- **Симптом:** после изменения kwargs просела скорость. **Причина:** `mm_hash` изменился, кэш препроцессора начал с нуля. **Действие:** ожидаемо и разово.
- **Подтверждение принятого значения:** словарь виден в стартовой строке конфига как `mm_processor_kwargs={...}`; косвенно — по изменившемуся числу токенов на изображение в логах запроса.

## Примеры

```bash
vllm serve /models/Phi-3-vision-128k-instruct --trust-remote-code --mm-processor-kwargs '{"num_crops": 4}' --limit-mm-per-prompt '{"image": 2}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-kwargs.min_pixels 200704 --mm-processor-kwargs.max_pixels 1003520 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/multimodal/processing/context.py`
- `vllm/vllm/multimodal/processing/processor.py`
- `vllm/vllm/entrypoints/chat_utils.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/docs/configuration/conserving_memory.md`
