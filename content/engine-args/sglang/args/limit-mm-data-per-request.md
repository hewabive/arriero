---
schema: 1
engine: sglang
primaryName: "--limit-mm-data-per-request"
title: "--limit-mm-data-per-request"
summary: Потолок числа картинок/видео/аудио в одном запросе, проверяемый в tokenizer-процессе до декодирования данных. Единственная дешевая защита от запроса на сто изображений, которая срабатывает раньше, чем хост начнет их скачивать.
group: mm
related:
  - --mm-process-config
  - --enable-multimodal
  - --mm-io-worker-num
  - --mm-processor-worker-num
  - --mm-feature-transport
  - --chunked-prefill-size
  - --context-length
---

# --limit-mm-data-per-request

## Кратко

`--limit-mm-data-per-request` принимает JSON-объект вида `{"image": 4, "video": 1, "audio": 1}` и задает максимальное число элементов каждой модальности в одном запросе. Проверка выполняется в `TokenizerManager` **до** того, как IO-воркеры начнут скачивать и декодировать данные, поэтому она защищает и от расхода RAM, и от расхода времени. Ничего не резервирует и не влияет на размер входа в токенах — это чисто входной валидатор с точным сообщением об ошибке.

## Оригинальная справка

```text
Limit the number of multimodal inputs per request. e.g. '{"image": 1, "video": 1, "audio": 1}'
```

## Паспорт аргумента

- Флаги: `--limit-mm-data-per-request`
- Группа: `mm`
- Тип значения: JSON-объект; поле объявлено как `Optional[Union[str, Dict[str, int]]]` с `type_parser=json.loads`, то есть argparse разбирает строку как JSON прямо на этапе парсинга
- Допустимые значения: объект, ключи которого — только `image`, `video`, `audio`; значения — целые числа
- Значение по умолчанию: `null` — лимитов нет
- Эффективное значение: не переопределяется; `__post_init__` только валидирует набор ключей
- Где объявлен: `ServerArgs.limit_mm_data_per_request`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI (`json.loads`) → валидация ключей в `__post_init__` → проверка каждого входящего запроса в `TokenizerManager._validate_mm_limits`

## Что меняет в движке

Значение читается ровно в одном месте — `sglang/python/sglang/srt/managers/tokenizer_manager.py`:

```python
def _validate_mm_limits(self, obj):
    if not self.server_args.limit_mm_data_per_request:
        return
    for modality, limit in self.server_args.limit_mm_data_per_request.items():
        data = getattr(obj, f"{modality}_data", None)
        if data:
            count = len(data) if isinstance(data, list) else 1
            if count > limit:
                raise ValueError(
                    f"{modality.capitalize()} count {count} exceeds limit {limit} per request."
                )
```

Вызов стоит в `_tokenize_one_request` сразу после нормализации `image_data`/`video_data`/`audio_data` в списки и **до** запуска мультимодального процессора. Значит: URL еще не скачаны, кадры видео не декодированы, тензоры не выделены. Запрос отклоняется на самом дешевом из возможных мест.

Считаются **элементы верхнего уровня**, а не кадры и не пиксели. Для видео `{"video": 1}` означает «один видеофайл», а не «один кадр» — сколько кадров вытащить из этого файла, решают `--mm-process-config` и модель.

В `__post_init__` (`sglang/python/sglang/srt/server_args.py`) выполняется только структурная проверка: если значение пришло строкой (Python-API), оно разбирается `json.loads`; затем каждый ключ сверяется с `{"image", "video", "audio"}`, и неизвестный ключ приводит к `ValueError: Invalid modality '<key>' in --limit-mm-data-per-request. Allowed modalities are: ['image', 'video', 'audio']`. Числа не проверяются вообще.

## Значения и формат

- Одна строка валидного JSON: `--limit-mm-data-per-request '{"image": 4, "video": 1}'`. Кавычки обязательны, объект должен быть целым аргументом — argparse не склеивает куски.
- Перечислять все три модальности не нужно: отсутствующий ключ = «без лимита».
- `0` работает как «эта модальность запрещена»: любое непустое `image_data` даст `count >= 1 > 0`. Это единственный способ закрыть модальность через данный аргумент.
- Отрицательные и нулевые значения argparse принимает — семантической проверки на них нет.
- Невалидный JSON отклоняется парсером аргументов с ошибкой `json.decoder.JSONDecodeError`, а не аккуратным сообщением.
- Ключ вне тройки допустимых валится не в argparse, а позже, в `__post_init__`.

## Когда использовать

- Сервер доступен не только с localhost: без лимита один запрос с сотней URL заставит IO-воркеры скачать и декодировать сотню изображений в RAM хоста, а затем построить из них тензоры. Это самый простой DoS по памяти в мультимодальном развертывании.
- Известен профиль трафика («один кадр на запрос», «до четырех страниц документа») — зафиксируйте его, чтобы аномалия падала быстрым 400, а не выедала пул.
- Модель формально принимает видео, но обслуживать вы его не собираетесь: `{"video": 0, "audio": 0}` закрывает модальности явно.
- **Не используйте** как средство ограничить длину prompt в токенах: за это отвечают `--context-length`, `--max-prefill-tokens` и `--chunked-prefill-size`. Одна картинка высокого разрешения легко дает больше токенов, чем десять маленьких.

## Влияние на производительность и память

- Сам аргумент не выделяет ничего и на скорость не влияет — одна проверка длины списка на запрос.
- Косвенно это самый действенный ограничитель пикового расхода RAM хоста в мультимодальном тракте: каждый принятый элемент проходит скачивание, декодирование, препроцессинг (resize/normalize) и превращается в тензор `pixel_values`, который затем едет в scheduler через `/dev/shm` или через пул на GPU.
- Ограничивает и пиковую нагрузку на пул IO-потоков: `--mm-io-worker-num` задает ширину пула, а этот аргумент — длину очереди, которую один запрос в него положит.

## Взаимодействие с другими аргументами

- `--mm-process-config`: ограничивает не количество, а «размер» каждого элемента (`max_pixels`, `fps`, `max_frames`). Пара «сколько штук × насколько большие» полностью определяет верхнюю границу расхода на запрос; по отдельности ни один из двух аргументов ее не задает.
- `--mm-io-worker-num`, `--mm-processor-worker-num`: ширина пулов, которые будут обрабатывать принятые элементы.
- `--mm-feature-transport`: определяет, куда лягут получившиеся признаки (RAM/`/dev/shm` или ограниченный пул на GPU); при `cuda_ipc` большое число элементов быстрее переполняет пул и роняет транспорт в CPU-фолбэк.
- `--enable-multimodal`: без мультимодального тракта проверка не выполняется, потому что `_validate_mm_limits` вызывается только когда процессор создан и в запросе действительно есть мультимодальные данные.
- `--chunked-prefill-size`, `--context-length`: ограничивают уже развернутый в токены вход, то есть работают на следующем этапе.

## Типовые проблемы и диагностика

- `Image count 12 exceeds limit 4 per request.` — сработал лимит; сообщение содержит и фактическое, и настроенное число, менять сервер не обязательно.
- `ValueError: Invalid modality 'images' in --limit-mm-data-per-request. Allowed modalities are: ['image', 'video', 'audio']` — во множественном числе; ключи строго в единственном.
- `json.decoder.JSONDecodeError` при старте — JSON не в кавычках или собран из нескольких аргументов оболочкой.
- Лимит задан, но не срабатывает: проверьте, что запрос действительно кладет данные в `image_data`/`video_data`/`audio_data` — при batched-запросе нормализация раскладывает данные по под-запросам, и лимит применяется к каждому из них отдельно.
- Что принято, видно в дампе `server_args=` при старте: там значение уже разобрано в словарь.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --limit-mm-data-per-request '{"image": 4, "video": 1, "audio": 0}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --limit-mm-data-per-request '{"image": 2}' --mm-process-config '{"image":{"max_pixels":1048576}}' --mm-io-worker-num 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/io_struct.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/docs/docs/supported-models/multimodal_language_models.mdx`
