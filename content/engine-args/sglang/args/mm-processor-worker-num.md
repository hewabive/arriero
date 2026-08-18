---
schema: 1
engine: sglang
primaryName: "--mm-processor-worker-num"
title: "--mm-processor-worker-num"
summary: Число потоков, на которых параллельно выполняется вызов HF-процессора мультимодальных данных. Каждый поток получает собственную полную копию процессора, поэтому значение прямо умножает расход RAM хоста.
group: mm
related:
  - --mm-io-worker-num
  - --tokenizer-worker-num
  - --mm-process-config
  - --limit-mm-data-per-request
  - --disable-fast-image-processor
  - --enable-multimodal
---

# --mm-processor-worker-num

## Кратко

`--mm-processor-worker-num` задает ширину пула потоков `sglang-mm-processor`, на котором выполняется `processor.__call__` — тяжелый CPU-этап между «данные декодированы» и «есть тензор `pixel_values`». Значение `0` (по умолчанию) означает «взять модель-специфичный дефолт»: 1 у большинства процессоров и 2 у Qwen-VL/Kimi. Больше одного потока получают только процессоры, которые явно объявили `supports_mm_processor_concurrency = True`, — остальным значение молча снижается до 1 с предупреждением. Платой за каждый поток служит **полная копия HF-процессора** в RAM хоста.

## Оригинальная справка

```text
Number of threads for multimodal processor calls. 0 selects the model-specific default. Only processors with isolated-worker support can use more than one thread.
```

## Паспорт аргумента

- Флаги: `--mm-processor-worker-num`
- Группа: `mm`
- Тип значения: int
- Допустимые значения: неотрицательное целое; проверка `assert self.mm_processor_worker_num >= 0, "Multimodal processor worker num must >= 0"` в `__post_init__`
- Значение по умолчанию: `0` — «модель-специфичный дефолт»
- Эффективное значение: `BaseMultimodalProcessor.__init__` подставляет `auto_mm_processor_worker_num` при `0` и принудительно опускает до `1`, если процессор не поддерживает конкурентность или если клонировать его не удалось
- Где объявлен: `ServerArgs.mm_processor_worker_num`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструирование мультимодального процессора в tokenizer-процессе (после старта, до приема запросов)

## Что меняет в движке

Разрешение значения в `sglang/python/sglang/srt/multimodal/processors/base_processor.py`:

```python
self.mm_processor_worker_num = (
    1 if skip_mm_pool
    else requested_mm_processor_worker_num or self.auto_mm_processor_worker_num
)
if self.mm_processor_worker_num > 1 and not self.supports_mm_processor_concurrency:
    logger.warning(...)
    self.mm_processor_worker_num = 1
```

Обратите внимание: используется `or`, а не проверка на `None`. Поэтому `0` — единственное значение, означающее «авто»; `1` — это явная единица.

Модель-специфичные дефолты (`auto_mm_processor_worker_num`):

| Процессор | Авто-значение | Конкурентность |
| --- | --- | --- |
| `BaseMultimodalProcessor` (все остальные) | 1 | нет |
| Qwen-VL для `qwen2_vl`, `qwen2_5_vl`, `qwen3_vl`, `qwen3_vl_moe`, `qwen3_5`, `qwen3_5_moe`, `intern_s2_preview`, `interns2_mobius` | 2 | да |
| Kimi K2.5, Kimi K3 | 2 | да |

При значении > 1 создается `MultimodalProcessorExecutor` (`sglang/python/sglang/srt/multimodal/processors/executor.py`), который:

1. немедленно делает `copy.deepcopy(processor)` **на каждый воркер** и складывает клоны в список;
2. поднимает `ThreadPoolExecutor` на столько же потоков;
3. на первом вызове в каждом потоке забирает клон в `threading.local` — дальше поток работает со своей копией.

Изоляция нужна потому, что HF-процессоры держат мутируемое состояние и не потокобезопасны. Если `deepcopy` не удался, пишется предупреждение `Unable to clone the multimodal processor for concurrent workers; falling back to synchronous processing.` и значение откатывается к 1.

Отдельная ветка — экспериментальный Rust-сервер (`SGLANG_RUST_SERVER`): `NativeMmHost` читает то же поле, но авто-значением у него служит константа `AUTO_MM_WORKERS = 8`, и это число дополнительно участвует в разбиении CPU-ядер между launcher'ом и сервером.

## Значения и формат

- Целое ≥ 0. Отрицательное отвергается ассертом при старте.
- `0` — авто (1 или 2 в зависимости от процессора).
- `1` — строго синхронная обработка: пул не создается, клонов нет.
- Больше 1 имеет смысл только для процессоров с `supports_mm_processor_concurrency = True`; иначе в логе появится `Concurrent multimodal processing is not supported by <ClassName>; using synchronous processing.`
- Верхней границы нет, но стоимость линейна по RAM (см. ниже).

## Когда использовать

- В профиле видно, что при бурстовом поступлении запросов TTFT растет, а GPU при этом простаивает: значит узкое место — CPU-препроцессинг. Поднимать имеет смысл до 2-4.
- Модель Qwen-VL/Kimi (единственные, кто вообще может использовать > 1) и запросы короткие: комментарий в `qwen_vl.py` прямо говорит, что более высокие значения улучшают TTFT на коротких ответах, но **регрессируют throughput на длинных ответах на Blackwell** — запросы доезжают до планировщика слишком разрозненно и дробят prefill-батчи.
- **Не поднимайте**, если тормозит загрузка/декодирование данных (скачивание по URL, распаковка JPEG, декод видео) — это отдельный пул `--mm-io-worker-num`.
- **Не поднимайте на многоворкерном tokenizer'е бездумно**: реальное число копий процессора равно `--tokenizer-worker-num × --mm-processor-worker-num`.

## Влияние на производительность и память

- **RAM хоста — главная статья.** Каждый воркер сверх первого держит полный `deepcopy` HF-процессора: токенизатор (со всем словарем и merges), image-процессор, конфиги. Для крупных VLM это сотни мегабайт на копию, и копии создаются в конструкторе, то есть на старте, а не лениво.
- Умножается на число tokenizer-воркеров: у каждого свой экземпляр процессора и свой набор клонов.
- CPU: потоки Python держат GIL, но тяжелая часть препроцессинга уходит в нативный код torch/PIL/torchvision и реально распараллеливается. При этом они конкурируют за те же ядра, что и `--mm-io-worker-num`, `SGLANG_CPU_WORKERS` и сам event loop tokenizer'а.
- VRAM: не затрагивается напрямую. Косвенно — при работающем fast image processor часть препроцессинга идет на `cuda:<base_gpu_id>`, и больше параллельных вызовов означает больше одновременных временных тензоров на этой карте.
- Время старта: `deepcopy` процессора на каждый воркер выполняется при инициализации.

## Взаимодействие с другими аргументами

- `--mm-io-worker-num`: соседний пул, отвечающий за загрузку и декодирование. Их роли не пересекаются; при неверном диагнозе увеличение «не того» пула ничего не дает.
- `--tokenizer-worker-num`: множитель для числа копий процессора и для суммарного расхода RAM.
- `--disable-fast-image-processor`: переводит с fast image processor'а на базовый; fast-вариант получает `device` (на CUDA — `cuda:<base_gpu_id>`) и может выполнять resize/normalize на GPU, базовый держит эту работу на CPU.
- `--mm-process-config`: чем меньше разрешение и число кадров, тем дешевле каждый вызов и тем меньше нужны дополнительные воркеры.
- `--limit-mm-data-per-request`: ограничивает длину очереди, которую один запрос кладет в пул.
- В arriero расход RAM этих пулов должен быть заложен в host-draw инстанса (`docs/RESOURCE_MANAGEMENT.md`): он постоянный, возникает на старте и не виден в оценке по весам модели.

## Типовые проблемы и диагностика

- `AssertionError: Multimodal processor worker num must >= 0` — отрицательное значение.
- `Concurrent multimodal processing is not supported by <ClassName>; using synchronous processing.` — процессор модели не объявил `supports_mm_processor_concurrency`; значение сброшено в 1, ничего чинить не нужно, кроме ожиданий.
- `Unable to clone the multimodal processor for concurrent workers; falling back to synchronous processing.` — `deepcopy` упал (обычно из-за нессериализуемого поля в кастомном процессоре с `--trust-remote-code`); в трейсбеке будет реальная причина.
- Хост уходит в своп сразу после старта VLM-сервера — сложите `--tokenizer-worker-num × --mm-processor-worker-num` копий процессора плюс `SGLANG_CPU_WORKERS` процессов пула препроцессинга.
- Подтверждение, что пул поднят: `Multimodal processor concurrency enabled with N isolated worker threads (auto|explicit).` Слово `explicit` означает, что число пришло из этого аргумента, `auto` — из дефолта процессора. При значении 1 строки нет вообще.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-processor-worker-num 4 --mm-io-worker-num 16
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-processor-worker-num 1 --tokenizer-worker-num 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/processors/executor.py`
- `sglang/python/sglang/srt/multimodal/processors/qwen_vl.py`
- `sglang/python/sglang/srt/multimodal/processors/kimi_k25.py`
- `sglang/python/sglang/srt/managers/rust_server.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
