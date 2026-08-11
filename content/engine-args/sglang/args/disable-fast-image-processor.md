---
schema: 1
engine: sglang
primaryName: "--disable-fast-image-processor"
title: "--disable-fast-image-processor"
summary: Заставляет загрузить «медленную» (PIL-овую) версию image-процессора HuggingFace вместо быстрой torchvision-овой и убирает resize/normalize с GPU обратно на CPU. Нужен, когда быстрая версия дает другие пиксели или её нет для вашей модели.
group: mm
related:
  - --mm-process-config
  - --mm-io-worker-num
  - --mm-processor-worker-num
  - --base-gpu-id
  - --enable-multimodal
  - --trust-remote-code
  - --tokenizer-mode
---

# --disable-fast-image-processor

## Кратко

Флаг делает две вещи сразу. Первая: при конструировании процессора в `AutoProcessor.from_pretrained` передается `use_fast=False`, то есть загружается «медленная» реализация image-процессора (PIL/numpy) вместо быстрой (torchvision, работает с тензорами). Вторая: в вызов процессора перестает добавляться `device=cuda:<base_gpu_id>`, поэтому препроцессинг картинок (resize, rescale, normalize) уходит с GPU на CPU. Значение по умолчанию — быстрая версия на GPU.

## Оригинальная справка

```text
Adopt base image processor instead of fast image processor.
```

## Паспорт аргумента

- Флаги: `--disable-fast-image-processor`
- Группа: `mm`
- Тип значения: bool, `action="store_true"`
- Допустимые значения: значения не принимает — флаг присутствия
- Значение по умолчанию: `false` (то есть быстрая версия включена)
- Эффективное значение: не переопределяется в `__post_init__`; но `get_processor` может **сам** вернуться к быстрой версии, если у процессора нет медленной
- Где объявлен: `ServerArgs.disable_fast_image_processor`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструирование процессора в tokenizer-процессе (и в encode-сервере при EPD) → каждый вызов процессора

## Что меняет в движке

### На этапе загрузки процессора

`get_processor_wrapper` (`sglang/python/sglang/srt/managers/tokenizer_manager.py`) передает `use_fast=not server_args.disable_fast_image_processor` в `get_processor`. Там значение попадает в kwargs `AutoProcessor.from_pretrained` — **кроме** моделей типа `llava` и `clip`, для которых `use_fast` не проставляется вовсе.

Если у модели медленной версии не существует, `AutoProcessor` бросает `ValueError` с текстом «does not have a slow version», и обертка ловит его, печатает `Processor <path> does not have a slow version. Automatically use fast version` и повторяет загрузку с `use_fast=True`. То есть флаг — пожелание, а не гарантия.

Те же `use_fast=not disable_fast_image_processor` стоят на путях EPD (`disaggregation/encode_server.py`, `disaggregation/encode_receiver.py`).

### На этапе вызова процессора

`BaseMultimodalProcessor.process_mm_data` (`sglang/python/sglang/srt/multimodal/processors/base_processor.py`):

```python
if (
    hasattr(processor, "image_processor")
    and isinstance(processor.image_processor, BaseImageProcessor)
    and not self.disable_fast_image_processor
):
    device = self._fast_image_processor_device(processor)
    if device is not None:
        kwargs["device"] = device
```

`_fast_image_processor_device` возвращает:

- `"cpu"` — если платформа CPU или задан `--rl-on-policy-target`;
- `"xpu"` — на Intel XPU;
- `f"cuda:{server_args.base_gpu_id}"` — на CUDA (обычный случай);
- `"npu"` — на Ascend, попутно применяя патчи препроцессинга для Qwen-VL или GLM-4V.

Тот же блок продублирован в `ernie45_vl.py`.

Так что при выключенном флаге тяжелая часть препроцессинга (интерполяция и нормализация тензора изображения) выполняется **на GPU базового устройства**, в процессе tokenizer'а, а не на CPU.

## Значения и формат

- Флаг без значения; обратной половины `--no-...` нет.
- Он не отключает мультимодальность и не меняет размер изображений — за размеры отвечает `--mm-process-config`.
- Для `llava` и `clip` `use_fast` не передается в принципе, поэтому на них действует только вторая половина флага (отказ от `device=`).

## Когда использовать

- Быстрая версия процессора дает численно другой результат, и вам нужна точная воспроизводимость относительно референсной реализации: быстрая и медленная версии в transformers дают близкие, но не побитово одинаковые пиксели (разные библиотеки интерполяции).
- Быстрая версия падает или неверно работает для конкретного чекпойнта или кастомного процессора, подключенного через `--trust-remote-code`.
- Хочется убрать препроцессинг с GPU: при большом потоке мелких изображений вызовы препроцессинга на `cuda:<base_gpu_id>` конкурируют за ту же карту, на которой идет prefill.
- **Не включайте по умолчанию**: медленная версия действительно медленнее, и весь препроцессинг ложится на CPU хоста, который у мультимодального развертывания и так самый нагруженный ресурс.
- **Не используйте** как «фикс OOM»: перенос препроцессинга на CPU освобождает лишь временные тензоры, а не пул.

## Влияние на производительность и память

- CPU хоста: при включенном флаге вся арифметика препроцессинга уходит на CPU-потоки (`--mm-processor-worker-num`) и растет пропорционально числу и размеру изображений.
- GPU: при выключенном флаге на базовой карте появляются временные тензоры препроцессинга; их пик пропорционален числу одновременно обрабатываемых элементов.
- TTFT: медленная версия заметно увеличивает время подготовки входа, особенно на изображениях высокого разрешения.
- Постоянного расхода памяти ни в одном из режимов нет — обе версии процессора занимают сопоставимую RAM.
- На KV-пул, размер контекста и decode-фазу не влияет никак.

## Взаимодействие с другими аргументами

- `--mm-process-config`: набор поддерживаемых `images_kwargs` у быстрой и медленной версий может отличаться; после переключения проверьте, что ваши ключи всё ещё принимаются.
- `--mm-processor-worker-num`: при включенном флаге нагрузка на эти потоки растет.
- `--mm-io-worker-num`: отвечает за декодирование до препроцессинга; при GPU-декодировании (nvJPEG) изображение уже приходит тензором на GPU, и быстрая версия продолжает работу на той же карте.
- `--base-gpu-id`: карта, на которой выполняется быстрый препроцессинг.
- `--rl-on-policy-target`: принудительно опускает устройство препроцессинга до CPU даже без этого флага.
- `--trust-remote-code`, `--tokenizer-mode`: влияют на то, какой класс процессора вообще будет загружен.

## Типовые проблемы и диагностика

- `Processor <path> does not have a slow version. Automatically use fast version` — флаг задан, но медленной реализации нет; движок молча продолжил с быстрой.
- `ValueError`/`TypeError` из `AutoProcessor.from_pretrained`, не связанные со «slow version», пробрасываются наружу и валят старт — обычно это несовместимость версии transformers с чекпойнтом.
- CUDA-ошибка или неожиданный рост памяти на `--base-gpu-id` во время препроцессинга — попробуйте флаг, чтобы вынести эту работу на CPU и подтвердить диагноз.
- Численные расхождения с референсом на пиксельном уровне — ожидаемое различие быстрой и медленной реализаций; флаг именно для этого случая.
- Значение видно в дампе `server_args=` при старте; отдельной строки о выбранной реализации процессора движок не печатает, кроме сообщения об автоматическом откате выше.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --disable-fast-image-processor
```

```bash
python -m sglang.launch_server --model-path /models/InternVL3-8B --trust-remote-code --disable-fast-image-processor --mm-processor-worker-num 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/processors/ernie45_vl.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
