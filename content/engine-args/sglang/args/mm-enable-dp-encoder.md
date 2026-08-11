---
schema: 1
engine: sglang
primaryName: "--mm-enable-dp-encoder"
title: "--mm-enable-dp-encoder"
summary: Переводит визуальный энкодер из тензорного параллелизма в data-параллельный: каждый TP-ранг держит полную копию ViT и обрабатывает свою долю изображений. Уменьшает TTFT на многокартиночном prefill, но реплицирует веса энкодера и добавляет all-gather.
group: mm
related:
  - --tp-size
  - --enable-multimodal
  - --mm-attention-backend
  - --mm-feature-transport
  - --enable-dp-attention
  - --limit-mm-data-per-request
---

# --mm-enable-dp-encoder

## Кратко

При `--mm-enable-dp-encoder` ViT перестает шардироваться по TP и вместо этого **реплицируется** на каждый ранг, а изображения запроса раскладываются по рангам жадным балансировщиком по суммарному размеру. Размер DP-группы не настраивается — он равен `--tp-size`. Выигрыш есть там, где ViT-prefill заметен в TTFT: много картинок или высокое разрешение. Ценой служат копия весов энкодера на каждой карте и all-gather эмбеддингов с паддингом до максимума по рангам.

## Оригинальная справка

```text
Enabling data parallelism for mm encoder. The dp size will be set to the tp size automatically.
```

## Паспорт аргумента

- Флаги: `--mm-enable-dp-encoder`
- Группа: `mm`
- Тип значения: bool, `action="store_true"`
- Допустимые значения: значения не принимает — флаг присутствия; пары `--no-...` нет
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; в `_handle_data_parallelism` только печатается предупреждение или информационная строка
- Где объявлен: `ServerArgs.mm_enable_dp_encoder`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (диагностика) → конструирование модели (`self.use_data_parallel` в vision-части) → каждый forward мультимодального prefill

## Что меняет в движке

Модели читают значение один раз при построении: `self.use_data_parallel = get_mm().mm_enable_dp_encoder`. Так делают `qwen2_5_vl.py`, `qwen3_vl.py`, `internvl.py`, `glm4v.py`, `glm4v_moe.py`, `glm_image_vl.py`, `glm_ocr.py`, `kimi_vl.py`, `kimi_k25.py`, `mimo_vl.py`, `minimax_vl_common.py`, `minimax_m3_vl.py`. Модель, которая этого поля не читает, флаг просто игнорирует.

Раскладка работы (`sglang/python/sglang/srt/multimodal/mm_utils.py`):

1. Для каждого изображения считается «размер» как `prod(grid_thw)` — число патчей, а не число картинок.
2. `get_dp_encoder_lb_assignment(sizes, num_gpus)` жадно раздает изображения от самого большого к самому маленькому рангу с минимальной текущей нагрузкой. Балансировка идет **по суммарному размеру**, поэтому одна огромная картинка и десять маленьких распределяются осмысленно.
3. Каждый ранг прогоняет свою долю через полную копию ViT. Ранг, которому ничего не досталось, создает пустой тензор нужной формы, чтобы коллектив не сломался.
4. Результаты собираются: при одном изображении — `broadcast` от владельца (быстрый путь, битово идентичный общему), при нескольких — паддинг локальных эмбеддингов до `max_len_per_rank` и `all_gather` по `attn_tp_group` с последующей нарезкой.

Пункт 4 объясняет, где теряется выигрыш: паддинг идет до максимума по рангам, поэтому при сильно неравномерной раскладке (одна картинка много больше остальных) через all-gather летит заметно больше данных, чем полезной нагрузки.

`__post_init__._handle_data_parallelism` при `--tp-size 1` пишет предупреждение:

```text
--mm-enable-dp-encoder is enabled with TP=1, so the encoder has no data-parallel work to distribute. Disable it unless you need to validate this configuration.
```

а при TP > 1 — информационную строку, которая прямо предупреждает: на мелких изображениях репликация и агрегация могут стоить дороже выигрыша, и это надо измерять.

Есть и связка с транспортом признаков: `qwen_vl.py` при `use_cuda_ipc and mm_enable_dp_encoder` помечает признаки маркером отложенной реконструкции CUDA IPC — каждый признак потребляется на одном TP-ранге, и планировщик держит его «ленивым», пока модель не вычислит DP-раскладку.

## Значения и формат

- Флаг без значения. Отключить его после включения из командной строки нельзя — только убрать флаг.
- Размер DP-группы задать нельзя: он всегда равен `--tp-size`.
- При `--tp-size 1` флаг безвреден, но бессмыслен, о чем сервер и сообщает.

## Когда использовать

- Многокартиночные запросы или высокое разрешение на TP ≥ 2, и в профиле видно, что ViT-часть prefill сопоставима с LM-частью. ViT мал относительно LM, поэтому TP для него даёт мало, а all-reduce после каждого слоя — много.
- Есть запас VRAM: репликация энкодера отнимает у KV-пула столько, сколько весит ViT, на каждой карте кроме первой.
- **Не включайте** для одиночных мелких картинок: балансировать нечего, а паддинг и all-gather остаются.
- **Не включайте** на `--tp-size 1`.
- **Проверяйте по своей модели**: список поддержки не универсален. Апстрим-документация называет Qwen2.5-VL, Qwen3-VL, InternVL, GLM-4.5V/4.6V; в коде поле читают и другие модели, но модель без `use_data_parallel` флаг молча игнорирует.

## Влияние на производительность и память

- **VRAM: главный эффект.** При TP-шардировании веса ViT делятся между рангами; при DP каждый ранг держит полную копию. Разница — это `(tp_size − 1) × размер_ViT` дополнительной VRAM в сумме по узлу, и она вычитается из бюджета KV-пула, потому что пул считается по свободной памяти после загрузки весов.
- Активации: пиковая память ViT на ранге определяется размером его доли, а не всем запросом, — это как раз в плюс.
- Коммуникация: вместо all-reduce на каждом слое ViT остается один all-gather в конце, но с паддингом до максимума по рангам.
- TTFT: падает на многокартиночных запросах; на однокартиночных остается на месте (быстрый путь с broadcast).
- Throughput на длинных генерациях: не меняется — decode-фаза энкодер не трогает.

## Взаимодействие с другими аргументами

- `--tp-size`: задает размер DP-группы. Без TP > 1 флаг не работает.
- `--enable-dp-attention`: независимый механизм для языковой модели; раскладка изображений идет по `attn_tp_group`, поэтому при включенном DP-attention группа для сбора эмбеддингов — attention-TP, а не глобальная TP.
- `--mm-feature-transport`: при `cuda_ipc` вместе с DP-энкодером включается путь отложенной реконструкции признаков (Qwen-VL).
- `--mm-attention-backend`: ядро attention в реплицированном ViT то же самое на всех рангах.
- `--limit-mm-data-per-request`, `--mm-process-config`: определяют, сколько и какого размера работы будет что балансировать.
- В arriero репликация энкодера увеличивает фактический VRAM-draw инстанса — заявку в `config/resources.json` надо пересчитывать после включения флага (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `--mm-enable-dp-encoder is enabled with TP=1, ...` — флаг ничего не делает.
- OOM при загрузке весов после включения флага — это ровно репликация ViT; уменьшайте `--mem-fraction-static` или откатывайте флаг.
- Ускорения нет: посмотрите на распределение размеров изображений. Один большой файл на запрос → работа не балансируется, выигрыша быть не может.
- Включили, но в логе ничего не изменилось и поведение прежнее: модель не читает `use_data_parallel`. Проверьте по `sglang/python/sglang/srt/models/<модель>.py`.
- Подтверждение на старте — информационная строка `--mm-enable-dp-encoder is enabled across TP=N. It replicates the vision encoder ...`; значение аргумента видно в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen2.5-VL-7B-Instruct --tp-size 2 --mm-enable-dp-encoder
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-30B-A3B-Instruct --tp-size 4 --mm-enable-dp-encoder --mem-fraction-static 0.8 --limit-mm-data-per-request '{"image": 8}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multimodal/mm_utils.py`
- `sglang/python/sglang/srt/multimodal/encoder_preprocessing.py`
- `sglang/python/sglang/srt/multimodal/processors/qwen_vl.py`
- `sglang/python/sglang/srt/models/qwen2_5_vl.py`
- `sglang/docs/docs/advanced_features/dp_for_multi_modal_encoder.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
