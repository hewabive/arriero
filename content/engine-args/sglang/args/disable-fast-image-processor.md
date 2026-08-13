---
schema: 1
engine: sglang
primaryName: "--disable-fast-image-processor"
title: "--disable-fast-image-processor"
summary: Устаревший флаг, полностью заменённый на `--image-processor-backend=pil`. Пока принимается и переписывается в новое значение с предупреждением; в новых конфигурациях использовать не нужно.
group: mm
related:
  - --image-processor-backend
  - --mm-process-config
  - --mm-processor-worker-num
  - --mm-io-worker-num
  - --base-gpu-id
  - --rl-on-policy-target
  - --trust-remote-code
---

# --disable-fast-image-processor

## Кратко

Аргумент устарел. Он выражал булев выбор «быстрый процессор изображений или медленный», а этот выбор стал трёхзначным и переехал в `--image-processor-backend` (`auto` / `torchvision` / `pil`). Старый флаг эквивалентен новому `--image-processor-backend=pil`.

Он еще принимается: `_handle_deprecated_args` печатает предупреждение и выставляет `image_processor_backend = "pil"`. Семантика при этом полностью совпадает с новым флагом — включая то, что на `pil` препроцессинг никогда не уезжает на GPU. Всё содержательное описание поведения живёт в документе `--image-processor-backend`.

## Оригинальная справка

```text
Deprecated. Use --image-processor-backend=pil instead.
```

## Паспорт аргумента

- Флаги: `--disable-fast-image-processor`
- Группа: `mm`
- Тип значения: булев флаг (`store_true`, парного `--no-*` нет)
- Допустимые значения: наличие флага
- Значение по умолчанию: `False`
- Эффективное значение: поле `ServerArgs` не переписывается и остаётся `True`, но переписывается **соседнее** — `image_processor_backend` становится `"pil"`. Дальше движок читает только его
- Где объявлен: `ServerArgs.disable_fast_image_processor`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: **устаревший**, замена — `--image-processor-backend=pil`
- Этап применения: `__post_init__` → `_handle_deprecated_args()`; собственного пути исполнения у флага больше нет

## Что меняет в движке

Ничего напрямую. Единственное место, где значение читается по существу, — `_handle_deprecated_args`:

```python
if self.disable_fast_image_processor:
    if self.image_processor_backend not in {"auto", "pil"}:
        raise ValueError(...)
    logger.warning(
        "--disable-fast-image-processor is deprecated; use "
        "--image-processor-backend=pil instead."
    )
    self.image_processor_backend = "pil"
```

Плюс страховка на уровень ниже: `resolve_image_processor_backend` (`utils/hf_transformers/processor.py`) и конструктор `BaseMultimodalProcessor` тоже проверяют старое поле и возвращают/выставляют `"pil"` — на случай вызова в обход `__post_init__`. Внутренний признак `BaseMultimodalProcessor.disable_fast_image_processor`, который дальше гейтит `device=` в вызове процессора, теперь выводится не из аргумента, а из backend'а: `image_processor_backend == "pil"`.

Прежняя механика флага исчезла целиком, и это важно, если вы опираетесь на старые описания: `use_fast` больше не передаётся в `AutoProcessor.from_pretrained` из аргументов сервера (параметр `use_fast` остался только у функции `get_processor` и нормализуется в backend), исключения для `llava`/`clip` больше нет, и автоматического отката «does not have a slow version → повторить с быстрой версией» тоже больше нет. Вместо этого пересоздаётся под-процессор изображений с явным `backend=`.

## Значения и формат

- Флаг без значения. Задан = `--image-processor-backend=pil`.
- Совмещать с новым флагом можно, только если тот равен `auto` или `pil`. `torchvision` вместе со старым флагом — `ValueError` на старте.
- Обратной половины `--no-...` нет.

## Когда использовать

- Не использовать. В новых конфигурациях пишите `--image-processor-backend pil`.
- Единственный оставшийся сценарий — не трогать существующий конфиг, который уже содержит этот флаг и работает: поведение не изменилось, в логе будет одно предупреждение.
- При правке такого конфига заменяйте флаг сразу: устаревшие аргументы SGLang живут до релиза-другого.

## Влияние на производительность и память

Собственного влияния нет: флаг только выставляет `image_processor_backend`. Все эффекты (препроцессинг на CPU вместо GPU, рост TTFT на крупных изображениях, нагрузка на CPU-воркеры) описаны в `--image-processor-backend` для значения `pil`.

## Взаимодействие с другими аргументами

- `--image-processor-backend`: замена. Конфликт при значении `torchvision`, совместимость при `auto`/`pil`.
- `--mm-processor-worker-num`, `--mm-io-worker-num`: несут нагрузку CPU-препроцессинга, которую включает режим `pil`.
- `--base-gpu-id`: перестаёт участвовать в препроцессинге, потому что `device=` на `pil` не подставляется.
- `--rl-on-policy-target`: и без этого флага опускает препроцессинг на CPU.
- `--mm-process-config`, `--trust-remote-code`: влияют на то, какой процессор и с какими параметрами загрузится, но не на выбор backend'а.

## Типовые проблемы и диагностика

- **Симптом:** `--disable-fast-image-processor is deprecated; use --image-processor-backend=pil instead.` **Причина:** ожидаемое предупреждение. **Лечение:** заменить флаг.
- **Симптом:** `--disable-fast-image-processor conflicts with --image-processor-backend=torchvision.` **Причина:** оба флага заданы с противоположным смыслом. **Лечение:** оставить только `--image-processor-backend`.
- **Симптом:** в дампе `server_args=` видно `disable_fast_image_processor=True` **и** `image_processor_backend='pil'`. **Причина:** так и должно быть — старое поле не обнуляется, переписывается новое.
- **Симптом:** ожидался автоматический откат на быструю версию, как раньше, а его нет. **Причина:** ветка «does not have a slow version» удалена вместе со старой механикой. **Лечение:** выбирать backend явно.

## Примеры

Актуальная форма записи:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --image-processor-backend pil
```

Устаревшая форма, которая пока работает и даёт предупреждение:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --disable-fast-image-processor
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/processors/ernie45_vl.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
