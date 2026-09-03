---
schema: 1
engine: sglang
primaryName: "--mm-process-config"
title: "--mm-process-config"
summary: JSON с тремя секциями (`image`, `video`, `audio`), содержимое которых передается HF-процессору как `images_kwargs`/`videos_kwargs`/`audio_kwargs`. Главная ручка, которой ограничивают разрешение картинок и число кадров видео до того, как из них получатся токены.
group: mm
related:
  - --limit-mm-data-per-request
  - --enable-multimodal
  - --image-processor-backend
  - --mm-io-worker-num
  - --mm-processor-worker-num
  - --chunked-prefill-size
  - --context-length
---

# --mm-process-config

## Кратко

`--mm-process-config` — сквозной канал к препроцессору HuggingFace: то, что вы положите в секцию `image`, попадет в `images_kwargs` вызова процессора, `video` — в `videos_kwargs`, `audio` — в `audio_kwargs`. SGLang сам ничего из этих ключей не интерпретирует (за исключением видео-препроцессинга Qwen-VL и нескольких моделей, которые читают свои ключи явно). Практически это единственный способ сказать «не больше миллиона пикселей на картинку» и «не больше 60 кадров на видео» — то есть ограничить и расход памяти, и число мультимодальных токенов, попадающих в prefill.

## Оригинальная справка

```text
Multimodal preprocessing config, a json config contains keys: `image`, `video`, `audio`
```

## Паспорт аргумента

- Флаги: `--mm-process-config`
- Группа: `mm`
- Тип значения: JSON-объект; поле `Optional[Dict[str, Any]]` с `type_parser=json.loads`
- Допустимые значения: любой JSON-объект; осмысленные ключи верхнего уровня — `image`, `video`, `audio`, и значение каждого обязано быть объектом
- Значение по умолчанию: `null`
- Эффективное значение: `__post_init__` подставляет пустой словарь `{}`, если аргумент не задан, — процессоры затем читают `mm_process_config.get("image", {})` и т. д.
- Где объявлен: `ServerArgs.mm_process_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI (`json.loads`) → структурная проверка в `ServerArgs._handle_multimodal` (до загрузки модели) → конструктор `BaseMultimodalProcessor` → каждый вызов HF-процессора

## Что меняет в движке

`ServerArgs._handle_multimodal` проверяет только структуру: верхний уровень должен быть словарем, и каждый из ключей `image`/`video`/`audio`, если он присутствует, тоже должен быть словарем. Иначе — `TypeError`. Проверка стоит рано, до загрузки весов, поэтому опечатка в структуре не стоит вам минут ожидания.

`BaseMultimodalProcessor.__init__` раскладывает конфиг на три поля:

```python
self.image_config = mm_process_config.get("image", {})
self.video_config = mm_process_config.get("video", {})
self.audio_config = mm_process_config.get("audio", {})
```

В `process_mm_data` они мерджатся в аргументы вызова процессора:

```python
kwargs.setdefault("images_kwargs", {}).update(self.image_config)
kwargs.setdefault("videos_kwargs", {}).update(video_config)
kwargs.setdefault("audio_kwargs", {}).update(self.audio_config)
```

Разделение по модальностям здесь принципиально: ключ `max_pixels` в `image` и `max_pixels` в `video` не конфликтуют, потому что уезжают в разные kwargs-словари.

Отклонения от «просто прокинуть в HF-процессор», которые надо знать:

- **Qwen-VL** обрабатывает видео сам. `preprocess_video` читает из `video_config` ключи `fps`/`nframes`, `min_frames`/`max_frames`, `min_pixels`/`max_pixels`/`total_pixels`, `resized_height`/`resized_width` и по ним выбирает кадры (`smart_nframes`) и целевое разрешение. Эти же девять ключей затем **вырезаются** из того, что уходит в `videos_kwargs` (`QWEN_VIDEO_PREPROCESS_CONFIG_KEYS`), чтобы HF-процессор не сделал ту же работу второй раз. `fps` и `nframes` взаимоисключающи: одновременное указание падает на ассерте `Only accept either 'fps' or 'nframes'`.
- **MiniMax-M3-VL** извлекает из `video_config` ключи `fps`, `frame_max_size`, `max_frames` методом `pop`, то есть в HF-процессор они не попадают.
- **MiMo-V2** берет частоту дискретизации аудио по приоритету `processor_config` → `audio_config` → секция `audio` конфига и падает, если её нигде нет.
- **MiDashengLM** копирует всю секцию `audio` в `audio_kwargs`.

Ключи верхнего уровня, отличные от трех перечисленных, проверку проходят и молча игнорируются: никакой процессор их не читает.

## Значения и формат

- Одна строка валидного JSON: `--mm-process-config '{"image":{"max_pixels":1048576}}'`.
- Имена ключей внутри секций — это **имена аргументов конкретного HF-процессора**, а не словарь SGLang. Их перечень смотрите в документации процессора вашей модели; SGLang их не валидирует и неизвестный ключ передаст как есть (процессор либо проигнорирует его, либо упадет с `TypeError`).
- `{}` и отсутствие аргумента эквивалентны.
- Секция, значение которой не объект: `TypeError: mm_process_config['image'] must be a dict, but got <class 'int'>`.
- Не объект на верхнем уровне: `TypeError: mm_process_config must be a dict, but got <class 'list'>`.
- Единицы измерения — те же, что у процессора: `max_pixels` считается в пикселях **после** внутренних округлений по patch-фактору, `fps` — в кадрах в секунду исходного видео.

## Когда использовать

- Модель принимает изображения произвольного разрешения, а вам нужен предсказуемый потолок токенов на картинку: `{"image":{"max_pixels":1048576}}` ограничивает вход еще до того, как из него получатся мультимодальные токены.
- Видео: без ограничения `fps`/`max_frames` один длинный ролик легко даст десятки тысяч токенов и займет весь prefill-бюджет. `{"video":{"fps":3,"max_frames":60,"max_pixels":602112}}` — рабочая отправная точка из апстрим-документации.
- Аудио с нестандартной частотой дискретизации, которую процессор сам не выводит.
- **Не используйте** как ограничитель количества элементов — это `--limit-mm-data-per-request`. Один и второй аргумент закрывают разные половины формулы «сколько штук × насколько большие».
- **Не занижайте вслепую**: снижение `max_pixels` напрямую ухудшает качество распознавания мелкого текста и деталей. Это компромисс, а не бесплатная оптимизация.

## Влияние на производительность и память

- Ограничение разрешения и числа кадров сокращает всё сразу: объем декодированных данных в RAM хоста, время препроцессинга, размер тензора `pixel_values`, время прохода ViT, число мультимодальных токенов в prefill и объем KV, который они займут.
- Это самая эффективная ручка против OOM на мультимодальном prefill: она уменьшает вход, а не перераспределяет память.
- На decode-фазу не влияет — к моменту decode мультимодальные токены уже в KV-кеше.
- Сам разбор конфига стоит доли миллисекунды на запрос.

## Взаимодействие с другими аргументами

- `--limit-mm-data-per-request`: количество элементов; вместе с `--mm-process-config` дает верхнюю границу расхода на один запрос.
- `--chunked-prefill-size`, `--max-prefill-tokens`, `--context-length`: работают уже с развернутым в токены входом; если картинки не ограничены здесь, ограничивать придется там, и отказ будет грубее.
- `--image-processor-backend`: меняет реализацию image processor; набор поддерживаемых `images_kwargs` у torchvision- и PIL-версий может отличаться.
- `--mm-io-worker-num`, `--mm-processor-worker-num`: параллелизм на этапе, который этот конфиг настраивает.
- `--enable-multimodal`: без построенного мультимодального тракта конфиг не читается.

## Типовые проблемы и диагностика

- `TypeError: mm_process_config['video'] must be a dict, but got <class 'str'>` — секция задана строкой; проверьте кавычки во внешней оболочке.
- `AssertionError: Only accept either 'fps' or 'nframes'` — в секции `video` для Qwen-VL заданы оба ключа.
- `TypeError: ... got an unexpected keyword argument '<key>'` из HF-процессора — ключ существует у другой версии transformers или у другой модели.
- Значение задано, но не действует: почти всегда это Qwen-VL и ключ из `QWEN_VIDEO_PREPROCESS_CONFIG_KEYS` — его обрабатывает сам SGLang, а не HF-процессор, так что «не действует» надо проверять по числу мультимодальных токенов, а не по kwargs.
- Итоговое значение видно в дампе `server_args=` при старте — там оно уже разобрано в словарь (и `{}`, если аргумент не задавали).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-process-config '{"image":{"max_pixels":1048576},"video":{"fps":3,"max_pixels":602112,"max_frames":60}}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-process-config '{"image":{"max_pixels":602112}}' --limit-mm-data-per-request '{"image": 4, "video": 0}' --chunked-prefill-size 8192
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/processors/qwen_vl.py`
- `sglang/python/sglang/srt/multimodal/processors/minimax_m3_vl.py`
- `sglang/python/sglang/srt/multimodal/processors/mimo_v2.py`
- `sglang/docs/docs/supported-models/multimodal_language_models.mdx`
