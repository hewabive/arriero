---
schema: 1
engine: sglang
primaryName: "--dsa-paged-mqa-logits-backend"
title: "--dsa-paged-mqa-logits-backend"
summary: Ядро, которым индексер DSA считает paged MQA-логиты релевантности перед отбором top-k. Значимо только на DeepSeek-DSA моделях; `cutedsl` требует SM100 и выигрывает на малом батче и длинном контексте, `aiter` существует только на ROCm.
group: exec.kernel
related:
  - --dsa-topk-backend
  - --dsa-prefill-backend
  - --dsa-decode-backend
  - --attention-backend
  - --page-size
  - --kv-cache-dtype
---

# --dsa-paged-mqa-logits-backend

## Кратко

Индексер DSA перед отбором top-k считает по всем страницам KV матрицу логитов — это MQA-подобный GEMM над fp8-KV с постраничными таблицами. `--dsa-paged-mqa-logits-backend` выбирает ядро для этого шага. По умолчанию `auto`: DeepGEMM на CUDA, AITER на ROCm. Аргумент читается только внутри индексера DSA, то есть на моделях DeepSeek V3.2 / V4 / GLM DSA; на всех остальных он мертв.

## Оригинальная справка

```text
DSA indexer paged MQA logits kernel backend. Options: 'auto' (default; DeepGEMM on CUDA, aiter on ROCm), 'deepgemm', 'cutedsl' (CuTe DSL kernel, SM 100 (Blackwell) only; wins at low batch size and long context), 'aiter' (ROCm only).
```

## Паспорт аргумента

- Флаги: `--dsa-paged-mqa-logits-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `auto`, `deepgemm`, `cutedsl`, `aiter` (константа `DSA_PAGED_MQA_LOGITS_BACKEND_CHOICES`)
- Значение по умолчанию: `auto`
- Эффективное значение: разрешается не в `__post_init__`, а в `DSAPagedMQALogitsBackend.resolve` при построении индексера (`sglang/python/sglang/srt/layers/attention/dsa/paged_mqa_logits_backend.py`). На ROCm любое значение из `auto`/`aiter` превращается в `aiter`, а `deepgemm`/`cutedsl` дают `ValueError`. На CUDA `auto` и `deepgemm` → `deepgemm`; `aiter` → `ValueError`; `cutedsl` → проверка `is_sm100_supported()`
- Где объявлен: `ServerArgs.dsa_paged_mqa_logits_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → конструктор индексера DSA (`Indexer.__init__`) → каждый forward индексера

## Что меняет в движке

Разрешенное значение хранится в индексере как `self.paged_mqa_logits_backend` и ветвит вычисление логитов (`sglang/python/sglang/srt/layers/attention/dsa/dsa_indexer.py`):

- **`aiter`** → `aiter_paged_mqa_logits` с флагом preshuffle и размером KV-блока, равным `--page-size`.
- **`cutedsl`** → `cutedsl_paged_mqa_logits`. Путь применяется не всегда: он выключается для `draft_extend_v2`, а на target-verify со спекуляцией (`next_n >= 2`) дополнительно подбираются параметры развертки через `pick_dsl_expand` (по числу SM, батчу, максимальному контексту и числу голов). Расписание задач при этом все равно берется у DeepGEMM (`get_paged_mqa_logits_metadata`).
- **`deepgemm`** → `deepgemm_paged_mqa_logits_native` для target-verify с подходящей 2-D формой длин контекста, иначе `deepgemm_paged_mqa_logits_split`. Оба поверх `deep_gemm.fp8_paged_mqa_logits`.

Индексер также ограничивает число SM для DeepGEMM, когда включен pipeline parallelism и один SM занят приемом от предыдущей стадии.

Проверки железа делаются в `resolve` — то есть отказ приходит при инициализации модели, а не при разборе аргументов, но до первого запроса.

## Значения и формат

- `auto` — рекомендуемое: единственное значение, корректное и на CUDA, и на ROCm.
- `deepgemm` — явная фиксация CUDA-пути; на ROCm `ValueError`.
- `cutedsl` — только SM100, и только на CUDA. Отказ: `dsa_paged_mqa_logits_backend='cutedsl' requires SM100 (Blackwell).`
- `aiter` — только ROCm. Отказ на CUDA: `dsa_paged_mqa_logits_backend='aiter' requires ROCm.`
- На ROCm любое значение кроме `auto`/`aiter` дает `dsa_paged_mqa_logits_backend=<x> is not supported on ROCm; only 'aiter' is implemented.`
- Значение вне списка отвергает argparse.

## Когда использовать

- `cutedsl` на Blackwell — когда профиль нагрузки соответствует тому, ради чего ядро сделано: маленький батч и длинный контекст (это прямо написано в справке аргумента). На большом батче выигрыш ожидать не стоит.
- `deepgemm` — чтобы зафиксировать поведение при отладке или сравнении.
- Не задавайте `aiter`/`cutedsl` в переносимом конфиге: значение привязано к платформе и на другой машине уронит старт.
- На модели без DSA аргумент бессмысленен.

## Влияние на производительность и память

- **TPOT и TTFT на DSA-моделях.** Логиты индексера считаются на каждом слое и каждом проходе по всему актуальному KV — это одна из самых дорогих частей DSA, особенно на длинном контексте.
- **VRAM.** Прямого влияния нет: ядра работают на уже выделенных буферах KV и таблицах страниц.
- **Время старта.** `cutedsl` компилируется JIT; DeepGEMM тоже JIT, если включен.
- **Спекуляция.** На target-verify выбор пути дополнительно зависит от `next_n` и формы метаданных, так что эффект аргумента при спекулятивном декодировании отличается от обычного декода.

## Взаимодействие с другими аргументами

- `--dsa-topk-backend`: следующий шаг того же индексера — отбор top-k по этим логитам.
- `--dsa-prefill-backend`, `--dsa-decode-backend`: само разреженное внимание после отбора; выбираются независимо.
- `--attention-backend`: значим только при `dsa`/`dsv4`.
- `--page-size`: становится размером KV-блока в вызове ядра; для DSA-моделей движок ставит 64 (на ROCm без preshuffle-пути — 1).
- `--kv-cache-dtype`: ядра работают с fp8-KV индексера; тип основного KV задается отдельно.
- `--pp-size`: при pipeline parallelism индексер уменьшает число доступных DeepGEMM SM на единицу.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: dsa_paged_mqa_logits_backend='cutedsl' requires SM100 (Blackwell).` **Причина:** конфиг с Blackwell на другой карте.
- **Симптом:** `ValueError: dsa_paged_mqa_logits_backend='aiter' requires ROCm.` **Причина:** ROCm-конфиг на NVIDIA.
- **Симптом:** `ValueError: dsa_paged_mqa_logits_backend='deepgemm' is not supported on ROCm; only 'aiter' is implemented.`
- **Симптом:** задан `cutedsl`, а профиль не изменился на спекулятивной нагрузке. **Причина:** путь выключен для `draft_extend_v2` и по-разному ведет себя на target-verify.
- **Проверка:** дамп `server_args=` при старте показывает заданное значение; разрешение `auto` в дампе не видно и определяется платформой.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --kv-cache-dtype fp8_e4m3 --dsa-paged-mqa-logits-backend cutedsl --page-size 64
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --kv-cache-dtype fp8_e4m3 --dsa-paged-mqa-logits-backend auto --dsa-topk-backend sgl-kernel --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/dsa/paged_mqa_logits_backend.py`
- `sglang/python/sglang/srt/layers/attention/dsa/dsa_indexer.py`
- `sglang/python/sglang/srt/layers/attention/dsa_backend.py`
