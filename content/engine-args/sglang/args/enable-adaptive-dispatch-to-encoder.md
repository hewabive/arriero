---
schema: 1
engine: sglang
primaryName: "--enable-adaptive-dispatch-to-encoder"
title: "--enable-adaptive-dispatch-to-encoder"
summary: Отправлять на энкодер только «тяжелые» мультимодальные запросы, а лёгкие обрабатывать локально. Порог — число элементов в запросе, задается переменной `SGLANG_ENCODER_DISPATCH_MIN_ITEMS` (по умолчанию 2).
group: disagg
related:
  - --language-only
  - --encoder-only
  - --encoder-urls
  - --encoder-transfer-backend
  - --encoder-bootstrap-port
  - --mm-feature-transport
---

# --enable-adaptive-dispatch-to-encoder

## Кратко

В EPD по умолчанию **любой** мультимодальный запрос уходит на энкодер, даже если в нем одна картинка: сетевой круг ради одного ViT-прогона иногда дороже самого прогона. Флаг включает пороговое решение: запросы с числом мультимодальных элементов ниже порога считаются локально, остальные диспетчеризуются. Побочный эффект, о котором легко забыть: включение флага меняет способ формирования эмбеддингов в батче — появляется разделение на «уже посчитанные» и «считаемые локально» подгруппы.

## Оригинальная справка

```text
When enabled, adaptively dispatch: multi-image requests go to encoder in language_only epd mode, single-image requests are processed locally.
```

## Паспорт аргумента

- Флаги: `--enable-adaptive-dispatch-to-encoder`
- Группа: `disagg`
- Тип значения: bool (`action="store_true"`, парного `--no-*` нет)
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false` — диспетчеризуются все мультимодальные запросы
- Эффективное значение: совпадает с заданным; движок его не переписывает
- Где объявлен: `ServerArgs.enable_adaptive_dispatch_to_encoder`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → создание MM-processor'а (флаг задает `skip_mm_pool`) → на каждом мультимодальном запросе в `_handle_epd_disaggregation_encode_request` → на форварде при сборке эмбеддингов (`managers/mm_utils.py`)

## Что меняет в движке

### Решение о диспетчеризации

`TokenizerManager._handle_epd_disaggregation_encode_request` вызывается для каждого запроса с мультимодальным входом при `--language-only`. Без флага `should_dispatch = True` безусловно. С флагом решение принимает `_should_dispatch_to_encoder`, который складывает число элементов всех модальностей (`image_data`, `video_data`, `audio_data`) и сравнивает с `SGLANG_ENCODER_DISPATCH_MIN_ITEMS` (по умолчанию `2`):

```python
return total_mm_items >= envs.SGLANG_ENCODER_DISPATCH_MIN_ITEMS.get()
```

Результат записывается в `obj.need_wait_for_mm_inputs`. При `False` запрос идет обычным локальным путем: `mm_processor.process_mm_data_async(...)` в tokenizer manager, а эмбеддинги считает сама модель на форварде.

### MM-пул процессора

Флаг пробрасывается в `get_mm_processor(..., skip_mm_pool=not enable_adaptive_dispatch_to_encoder)`. То есть без флага пул мультимодального процессора пропускается, а с флагом — создается: локальный путь должен быть полноценно работоспособен.

### Сборка эмбеддингов на форварде

`managers/mm_utils.py` при включенном флаге вызывает `_embed_mm_inputs_with_split` вместо `embed_mm_inputs`: батч разделяется на элементы с уже готовыми (`precomputed_embeddings`, приехавшими от энкодера) и на те, которые надо посчитать локально, чтобы `get_embedding_and_mask` видел однородные группы. Это не оптимизация, а условие корректности смешанного батча.

## Значения и формат

- Флаг без значения.
- Порог задается **не аргументом**, а переменной окружения `SGLANG_ENCODER_DISPATCH_MIN_ITEMS` (целое, по умолчанию `2`). Значение `1` вернет поведение «диспетчеризовать всё», значение `3` оставит локально запросы с одной и двумя картинками.
- Считаются элементы всех модальностей суммарно, а не только изображения, несмотря на формулировку справки про «single-image».
- Читается на сервере с `--language-only`; на `--encoder-only` смысла не имеет.
- Локальный путь требует, чтобы сервер вообще умел считать визуальные эмбеддинги. У семейства Qwen VL визуальная башня при `--language-only` остается загруженной, поэтому локальный путь рабочий; для архитектур, где `--language-only` действительно отбрасывает визуальные веса (Kimi-VL, Kimi-K3, dots_vlm), проверяйте это на своей модели перед включением флага.

## Когда использовать

- Смешанный трафик, где преобладают запросы с одной картинкой: круг до энкодера и обратно для них — чистые накладные расходы.
- Энкодерный пул перегружен многоэлементными запросами, и мелкие стоят у него в очереди.
- Не включайте, если цель разгрузки — освободить VRAM языкового сервера от визуальной башни: локальный путь ее использует.
- Не включайте на пути `zmq_to_tokenizer`, не проверив: там локальный путь и отказной 503 живут рядом, и логика становится менее предсказуемой.
- Не рассчитывайте настроить порог из CLI — только переменной окружения.

## Влияние на производительность и память

- **Latency.** Для запросов ниже порога TTFT падает на время сетевого круга; для остальных не меняется.
- **VRAM языкового сервера.** Растет: локальный ViT-прогон нужен для активаций, а MM-пул процессора теперь создается.
- **Нагрузка на энкодеры.** Падает пропорционально доле мелких запросов.
- **Форвард.** `_embed_mm_inputs_with_split` разбивает батч на подгруппы — при сильно смешанном батче это чуть дороже одного однородного вызова.
- **Хост.** MM-процессор с пулом использует рабочие процессы предобработки (`SGLANG_ENCODER_PREPROC_WORKERS` на энкодерной стороне; на языковой — обычные настройки мультимодального процессора).

## Взаимодействие с другими аргументами

- `--language-only`: единственный режим, где флаг работает.
- `--encoder-transfer-backend`: определяет, что происходит с диспетчеризованными запросами. На `zmq_to_scheduler`/`mooncake` недиспетчеризованный запрос обрабатывается локально в tokenizer manager; на `zmq_to_tokenizer` локальный путь тоже доступен, но отсутствие эмбеддингов у **диспетчеризованного** запроса дает 503.
- `--encoder-urls` / `--encoder-bootstrap-port`: если пул энкодеров пуст, диспетчеризация отменяется независимо от флага (`No encoder URLs available for request <rid>; processing without encoder disaggregation.`).
- `--mm-feature-transport`: локальный путь пользуется обычным транспортом мультимодальных признаков, а не `--encoder-transfer-backend`.

## Типовые проблемы и диагностика

- Флаг включен, но всё равно всё уходит на энкодер: проверьте `SGLANG_ENCODER_DISPATCH_MIN_ITEMS` — при значении `1` порог всегда выполняется.
- Флаг включен, но запросы обрабатываются локально: пул энкодеров пуст (`No encoder URLs available ...`) либо число элементов ниже порога.
- Рост VRAM на языковом сервере после включения — ожидаемо: локальный ViT-прогон и MM-пул.
- Ошибки при локальной обработке на модели, где `--language-only` отбрасывает визуальные веса, — флаг для такой связки не подходит; сверяйтесь с загрузчиком весов конкретной архитектуры.
- Диспетчеризация конкретного запроса видна по паре строк `[<rid>] Sending encode request to E, modalities=..., num_items=...` / `[<rid>] Received embedding from E in <t>s`: их отсутствие означает локальный путь.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --encoder-urls http://127.0.0.1:30000 --encoder-transfer-backend zmq_to_scheduler --enable-adaptive-dispatch-to-encoder --port 30002
```

```bash
SGLANG_ENCODER_DISPATCH_MIN_ITEMS=4 python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --encoder-urls http://enc0:30000 http://enc1:30001 --enable-adaptive-dispatch-to-encoder --port 30002
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/mm_utils.py`
- `sglang/python/sglang/srt/disaggregation/encode_receiver.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
