---
schema: 1
engine: sglang
primaryName: "--lora-backend"
title: "--lora-backend"
summary: Реализация ядер, считающих LoRA-дельту в батче. По умолчанию `csgmv` — чанковый SGMV, оптимизированный под высокую конкурентность и перекошенное распределение адаптеров.
group: lora
related:
  - --enable-lora
  - --max-lora-chunk-size
  - --max-loras-per-batch
  - --max-lora-rank
  - --cuda-graph-backend-prefill
  - --device
---

# --lora-backend

## Кратко

`--lora-backend` выбирает класс backend'а из реестра `LORA_SUPPORTED_BACKENDS`, который исполняет две дополнительные матричные операции LoRA (A- и B-проекции) поверх базового GEMM. Дефолт `csgmv` — реализация SGMV из статьи Punica с фиксированными чанками вместо сегментов переменной длины; апстрим приводит для нее выигрыш 20–80 % по latency относительно `triton`. Значение читается один раз при создании `LoRAManager`.

## Оригинальная справка

```text
Choose the kernel backend for multi-LoRA serving.
```

## Паспорт аргумента

- Флаги: `--lora-backend`
- Группа: `lora`
- Тип значения: строка
- Допустимые значения: `triton`, `csgmv`, `ascend`, `torch_native` (константа `LORA_BACKEND_CHOICES`)
- Значение по умолчанию: `csgmv`
- Эффективное значение: не переопределяется в `__post_init__`
- Где объявлен: `ServerArgs.lora_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `LoRAManager` (после загрузки весов модели, до выделения LoRA-пула)

## Что меняет в движке

`get_backend_from_name(name)` (`sglang/python/sglang/srt/lora/backend/lora_registry.py`) достает фабрику из реестра и лениво импортирует класс:

| Значение | Класс | Файл | Prefill CUDA graph |
| --- | --- | --- | --- |
| `csgmv` | `ChunkedSgmvLoRABackend` | `backend/chunked_backend.py` | да |
| `triton` | `TritonLoRABackend` | `backend/triton_backend.py` | да |
| `ascend` | `AscendLoRABackend` | `backend/ascend_backend.py` | нет |
| `torch_native` | `TorchNativeLoRABackend` | `backend/torch_backend.py` | нет |

Отдельная запись в реестре — `flashinfer`: она существует только для того, чтобы бросить понятную ошибку `FlashInfer LoRA backend has been deprecated, please use 'triton' instead.` В `choices` её нет, так что через CLI до неё не добраться.

Что различает реализации:

- **`csgmv`** режет последовательности батча на чанки фиксированного размера. Это сокращает число запусков ядер, особенно когда распределение адаптеров по запросам перекошено. Размер чанка выбирается эвристикой по числу токенов в батче и ограничивается сверху `--max-lora-chunk-size`.
- **`triton`** — базовая SGMV-реализация на Triton, с сегментами по запросам.
- **`ascend`** вызывает нативные операции `torch.ops.npu.sgemmv_shrink`/`expand` и требует `sgl_kernel_npu` и `torch_npu`; предназначен только для Ascend NPU.
- **`torch_native`** реализован на обычных операциях torch и держит часть метаданных батча дополнительно на CPU (`lora_ranks_cpu`, `seg_indptr_cpu`, `seg_lens_cpu`, `weight_indices_cpu`, `scalings_cpu`). Это самый переносимый и самый медленный вариант; полезен как эталон при отладке расхождений.

Флаг `supports_prefill_cuda_graph` у backend'а определяет, будет ли для prefill-фазы выделена статическая метаинформация LoRA-батча (`init_prefill_cuda_graph_batch_info`) и можно ли захватывать prefill в CUDA graph вместе с LoRA. У `ascend` и `torch_native` он `False`.

Backend также получает `max_loras_per_batch` и на его основе выделяет постоянные буферы метаданных батча (`lora_ranks`, `scalings`, `weight_indices`, `permutation`) для CUDA graph.

## Значения и формат

- Одна строка из четырех; всё прочее argparse отвергнет как `invalid choice`.
- `flashinfer` больше не принимается; при попытке добраться до него в обход `choices` будет `ValueError` с указанием заменителя.
- Значение глобальное — один backend на все LoRA-модули модели.
- Реестр расширяем декоратором `register_lora_backend` из кода, но CLI ограничен списком `LORA_BACKEND_CHOICES` вашей сборки: сверяйтесь с `python -m sglang.launch_server --help`.

## Когда использовать

- Оставьте `csgmv`: это дефолт, он же и рекомендованный апстримом вариант для сценариев с конкурентностью.
- `triton` — если наблюдаете некорректный результат или падение ядра csgmv, либо для сравнения при отладке производительности.
- `ascend` — обязателен на Ascend NPU; на CUDA он не заработает.
- `torch_native` — эталон корректности и запасной путь на платформе, где Triton недоступен. Для продакшена не годится по скорости.
- **Не подбирайте backend вслепую под низкую конкурентность**: разница между `csgmv` и `triton` проявляется при нескольких адаптерах в батче, а на одном адаптере и малом батче почти незаметна.

## Влияние на производительность и память

- **Latency/throughput.** Основной эффект аргумента. `csgmv` сокращает число запусков ядер на батче с несколькими адаптерами; `torch_native` заметно медленнее обоих Triton-вариантов.
- **VRAM.** Размер LoRA-пула от backend'а не зависит — он определяется `--max-loras-per-batch`, `--max-lora-rank` и целевыми модулями. Backend добавляет только небольшие буферы метаданных батча, размер которых пропорционален `max_loras_per_batch` и захваченным размерам батча CUDA graph.
- **CUDA graph.** У `ascend` и `torch_native` prefill-граф с LoRA недоступен, что само по себе может стоить больше, чем разница в ядрах.
- **Время старта.** Triton-ядра компилируются при первом использовании (JIT), поэтому первые запросы после старта медленнее.

## Взаимодействие с другими аргументами

- `--max-lora-chunk-size`: читается **только** backend'ом `csgmv`; для остальных значение игнорируется.
- `--max-loras-per-batch`: определяет размер буферов метаданных backend'а и потолок числа адаптеров в батче.
- `--max-lora-rank`: ранг попадает в ядра как размерность; на выбор backend'а не влияет.
- `--cuda-graph-backend-prefill`: prefill-граф с LoRA возможен только у backend'ов с `supports_prefill_cuda_graph`.
- `--device`: `ascend` осмыслен только на NPU.
- `--enable-lora`: без него backend не создается.

## Типовые проблемы и диагностика

- `argument --lora-backend: invalid choice: 'flashinfer'` — backend удален; используйте `triton`.
- `ValueError: Invalid backend: <name>` из `get_backend_from_name` — имя прошло `choices`, но отсутствует в реестре: рассинхрон версии установленного пакета и ожиданий.
- `ImportError: sgl_kernel_npu` при `ascend` — не установлен NPU-стек.
- Triton-ошибка компиляции на первом LoRA-запросе — попробуйте `torch_native`, чтобы отделить проблему ядра от проблемы конфигурации.
- Подтверждение выбора печатается при инициализации менеджера: `Using <backend> as backend of LoRA kernels.` Значение аргумента видно и в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-backend csgmv --max-loras-per-batch 16 --lora-paths lora1=/models/lora/lora1 lora2=/models/lora/lora2
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-backend triton --lora-paths lora1=/models/lora/lora1 --max-loras-per-batch 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/backend/lora_registry.py`
- `sglang/python/sglang/srt/lora/backend/chunked_backend.py`
- `sglang/python/sglang/srt/lora/backend/triton_backend.py`
- `sglang/python/sglang/srt/lora/backend/torch_backend.py`
- `sglang/python/sglang/srt/lora/backend/ascend_backend.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
