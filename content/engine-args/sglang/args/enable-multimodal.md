---
schema: 1
engine: sglang
primaryName: "--enable-multimodal"
title: "--enable-multimodal"
summary: Принудительно включает мультимодальный тракт для архитектур, у которых он по умолчанию выключен (Gemma 3, Llama 4, Step3-VL, Inkling). Это флаг-переключатель только «вверх» — выключить мультимодальность им нельзя.
group: mm
related:
  - --model-impl
  - --mm-attention-backend
  - --mm-feature-transport
  - --limit-mm-data-per-request
  - --mm-process-config
  - --image-processor-backend
  - --cuda-graph-backend-prefill
---

# --enable-multimodal

## Кратко

`--enable-multimodal` попадает в `ModelConfig` и решает, строит ли движок vision/audio-тракт вообще: загружать ли башню энкодера, создавать ли мультимодальный процессор в tokenizer-процессе, принимать ли `image_data`/`video_data`/`audio_data` в запросах. По умолчанию (`None`) значение подбирается по архитектуре: почти для всех мультимодальных моделей — `True`, для короткого черного списка — `False`. Флаг нужен ровно в одном случае: когда модель попала в этот черный список, а вам нужны картинки. Обратного действия у него нет — из командной строки его невозможно выставить в `false`.

## Оригинальная справка

```text
Enable the multimodal functionality for the served model. If the model being served is not multimodal, nothing will happen
```

## Паспорт аргумента

- Флаги: `--enable-multimodal`
- Группа: `mm`
- Тип значения: `Optional[bool]`; в argparse превращается в `action="store_true"` с `default=None` (`arg_groups/arg_utils.py`, ветка «Bool → store_true» после снятия `Optional`)
- Допустимые значения: значения не принимает — это флаг присутствия
- Значение по умолчанию: `null` — «решит `ModelConfig` по архитектуре»
- Эффективное значение: подставляется в `ModelConfig.__init__` (`sglang/python/sglang/srt/configs/model_config.py`), см. ниже
- Где объявлен: `ServerArgs.enable_multimodal`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → построение `ModelConfig` (до загрузки весов) → выбор мультимодального процессора в tokenizer-процессе → сборка модели → валидация входящих запросов

## Что меняет в движке

### Автоподбор, когда флаг не задан

`ModelConfig.__init__` при `enable_multimodal is None` идет по трем веткам:

1. Архитектура в списке `mm_disabled_models` — `Gemma3ForConditionalGeneration`, `Llama4ForConditionalGeneration`, `Step3VLForConditionalGeneration`, `InklingForConditionalGeneration` — и `--model-impl` не `transformers` ⇒ `False`, в лог уходит `Multimodal is disabled for <model_type>. To enable it, set --enable-multimodal.`
2. Чекпойнт семейства MiMo-V2, в конфиге которого нет ни `vision_config`, ни `audio_config` ⇒ `False` с пояснением «likely a text-only MiMoV2 variant».
3. Всё остальное ⇒ `True`.

То есть для Qwen-VL, InternVL, GLM-4V, Kimi-VL и прочих типовых VLM флаг не нужен: мультимодальность и так включена.

### Что именно гейтится значением

Все производные признаки `ModelConfig` умножаются на `enable_multimodal`:

- `is_multimodal` — главный признак; от него зависят выбор процессора (`get_processor_wrapper`), путь `general_mm_embed_routine` в forward, авто-выбор `--mm-feature-transport`;
- `is_audio_model`, `is_image_understandable_model`, `is_audio_understandable_model` — какие модальности сервер объявляет поддерживаемыми;
- `is_multimodal_chunked_prefill_supported` — можно ли резать prefill мультимодального запроса;
- `is_multimodal_piecewise_cuda_graph_supported` / `is_multimodal_breakable_cuda_graph_supported` — белый список архитектур, у которых LM-часть prefill всё-таки можно захватить в piecewise CUDA graph. Для остальных мультимодальных моделей prefill-граф отключается правилом «multimodal model» в `_handle_cuda_graph_config`.

Отдельные модели читают значение напрямую: `mllama4.py` строит vision-часть только при `has_vision_weights and enable_multimodal`, `inkling.py` — только при `bool(enable_multimodal)`.

### Почему нельзя выключить

Поле объявлено как `Optional[bool]`, но `add_cli_args_from_dataclass` для любого `bool` (в том числе развернутого из `Optional`) генерирует `action="store_true"`. Пары `--no-enable-multimodal` не существует. YAML-конфиг через `--config` тоже не поможет: `ConfigArgumentMerger._add_boolean_arg` для store_true-аргументов при значении `false` просто **не добавляет флаг** (`sglang/python/sglang/srt/server_args_config_parser.py`), то есть получается тот же `None`. Единственный способ получить `False` — Python-API: `ServerArgs(model_path=..., enable_multimodal=False)` или `sglang.Engine(..., enable_multimodal=False)`.

## Значения и формат

- Флаг без значения. `--enable-multimodal` ⇒ `True`, отсутствие ⇒ `None` (автоподбор).
- `--enable-multimodal true` argparse отвергнет: `unrecognized arguments: true`.
- На текстовой модели флаг безвреден: `is_multimodal` останется `False`, потому что он дополнительно требует `is_multimodal_model(architectures)` либо наличия под-конфига (`vision_config`/`audio_config`).

## Когда использовать

- Обслуживаете Gemma 3, Llama 4, Step3-VL или Inkling и вам нужны изображения — без флага сервер поднимется как чисто текстовый и на запрос с картинкой ответит ошибкой.
- Держите MiMo-V2-чекпойнт, у которого мультимодальные под-конфиги лежат нестандартно, и авто-детект ошибся в сторону «text-only».
- **Не трогайте** для Qwen-VL / InternVL / GLM-4V и т. п.: там уже `True`, и флаг ничего не изменит.
- **Не рассчитывайте** отключить им vision-башню ради экономии VRAM — механизма отключения у CLI нет; берите текстовый чекпойнт или `--language-only`-развертывание.

## Влияние на производительность и память

- VRAM: включенная мультимодальность означает загрузку весов энкодера (ViT/аудио-башни) в дополнение к LM. Для типовой 7-8B VLM это единицы гигабайт, и они вычитаются из бюджета, который останется под KV-пул (пул считается по свободной памяти уже после загрузки весов).
- RAM хоста: в tokenizer-процессе создается HF-процессор, пул IO-потоков (`--mm-io-worker-num`), опциональный пул потоков процессора (`--mm-processor-worker-num`) и `ProcessPoolExecutor` на `SGLANG_CPU_WORKERS` (по умолчанию `os.cpu_count()`) процессов. Это самая недооцененная статья расхода RAM у VLM-развертывания.
- Время старта: плюс загрузка весов энкодера и конструирование `AutoProcessor`.
- CUDA graph: для мультимодальной модели, не входящей в белый список, prefill-граф выключается — длинные prefill идут в eager-режиме.
- Для текстовой модели влияния нет вообще: значение не доходит ни до одного аллокатора.

## Взаимодействие с другими аргументами

- `--model-impl`: значение `transformers` снимает черный список — для Gemma 3 / Llama 4 / Step3-VL / Inkling мультимодальность включится автоматически даже без флага.
- `--mm-attention-backend`, `--mm-feature-transport`, `--mm-process-config`, `--limit-mm-data-per-request`, `--mm-processor-worker-num`, `--mm-io-worker-num`, `--image-processor-backend`: читаются только когда мультимодальный тракт вообще построен.
- `--cuda-graph-backend-prefill`: мультимодальная модель вне белого списка сама отключает piecewise-захват prefill.
- `--chunked-prefill-size`: резать prefill мультимодального запроса можно только у архитектур из `is_multimodal_chunked_prefill_supported`.
- `--language-only` / `--encoder-only`: разнесение энкодера и LM по разным процессам (EPD); там мультимодальность включена на энкодере, а LM-сервер работает с готовыми эмбеддингами.

## Типовые проблемы и диагностика

- В логе старта `Multimodal is disabled for gemma3. To enable it, set --enable-multimodal.` — сработал черный список. Добавьте флаг (или `--model-impl transformers`).
- Запрос с картинкой к серверу без мультимодальности возвращает ошибку от процессора/шаблона чата, а не понятное «vision disabled»: сначала проверьте стартовую строку из предыдущего пункта.
- `unrecognized arguments: true` — попытка передать флагу значение.
- `--enable-multimodal` добавили, но ничего не изменилось: значит модель и так была мультимодальной либо не мультимодальна вовсе (`is_multimodal_model(architectures)` дал `False`).
- Что реально принято, видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) — там будет `enable_multimodal=True` или `enable_multimodal=None`; итоговое решение по модели печатает `ModelConfig`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/gemma-3-12b-it --enable-multimodal --attention-backend triton --chunked-prefill-size -1
```

```bash
python -m sglang.launch_server --model-path /models/Llama-4-Scout-17B-16E-Instruct --enable-multimodal --tp-size 4 --limit-mm-data-per-request '{"image": 4}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/python/sglang/srt/server_args_config_parser.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/models/mllama4.py`
- `sglang/python/sglang/srt/models/inkling.py`
- `sglang/docs/docs/supported-models/multimodal_language_models.mdx`
