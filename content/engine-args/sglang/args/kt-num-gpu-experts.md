---
schema: 1
engine: sglang
primaryName: "--kt-num-gpu-experts"
title: "--kt-num-gpu-experts"
summary: Сколько экспертов каждого MoE-слоя остается на GPU; остальные считает CPU через kt-kernel. Главная ручка баланса VRAM против latency в гибридном режиме и обязательный аргумент при включенном KTransformers.
group: exec.moe
related:
  - --kt-weight-path
  - --kt-method
  - --kt-max-deferred-experts-per-token
  - --mem-fraction-static
  - --tp-size
---

# --kt-num-gpu-experts

## Кратко

`--kt-num-gpu-experts N` делит экспертов каждого MoE-слоя на две части: первые `N` физических идентификаторов остаются на GPU и считаются обычным quant-методом, остальные уходят в CPU-ядро kt-kernel. Разделение действует одновременно на загрузку весов (лишние эксперты просто не грузятся в VRAM) и на forward (их id маскируются перед GPU-ядром). Значения по умолчанию нет: при заданном `--kt-weight-path` аргумент обязателен.

## Оригинальная справка

```text
[ktransformers parameter] The number of GPU experts.
```

## Паспорт аргумента

- Флаги: `--kt-num-gpu-experts`
- Группа: `exec.moe`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: не ограничены на уровне argparse; осмысленный диапазон — от `0` до числа маршрутизируемых экспертов слоя
- Значение по умолчанию: `null` — SGLang ничего не подставляет
- Эффективное значение: не переопределяется; `ServerArgs.__post_init__` это поле не читает. Незаданное значение доходит до `mask_cpu_expert_ids` и до загрузчика весов как `None` и там участвует в сравнении с целым — то есть при включенном KT аргумент обязан быть задан
- Где объявлен: `ServerArgs.kt_num_gpu_experts`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; семантика распределения экспертов частично отличается в форке `sglang-kt` (см. ниже)
- Этап применения: создание весов MoE-слоя, загрузка весов, каждый forward MoE-слоя

## Что меняет в движке

Все три эффекта — в `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py` и `fused_moe_triton/layer.py`:

1. **Создание весов.** `KTEPWrapperMethod.create_weights` вызывает `gpu_method.create_weights(..., num_experts=self.num_gpu_experts, ...)` — на GPU создаются тензоры только под `N` экспертов. Туда же уходит `moe_runner_config.num_local_experts = num_gpu_experts`.
2. **Загрузка весов.** `FusedMoE._weight_loader_physical` при активной KT-обертке пропускает эксперты с `expert_id >= num_gpu_experts` (и только при `num_gpu_experts != -1`). Веса «холодных» экспертов в VRAM не попадают вообще, их читает kt-kernel из `--kt-weight-path`.
3. **Forward.** `mask_cpu_expert_ids` (скомпилированная `torch.compile` функция) выполняет `topk_ids[topk_ids >= num_gpu_experts] = -1`, после чего GPU-ядро эти позиции игнорирует. Параллельно `submit` отправляет полный `topk_ids` в CPU-обертку, а `sync` забирает результат и складывает с выходом GPU: `output = gpu_output + cpu_output`.

Обе части считаются одновременно: сначала неблокирующий `submit_forward` на CPU, затем GPU-эксперты, затем синхронизация. CPU-обертка живет только на `tp_rank == 0`; остальные ранги возвращают нули, чтобы сумма по TP-группе не удвоила вклад CPU.

**Расхождение с форком.** В checkout'е KTransformers `KTMoEWrapper` в режиме inference принимает уже не число, а булеву маску `gpu_experts_mask` и сопровождается флагами `--kt-expert-placement-strategy`, `--kt-gpu-experts-ratio`, `--kt-enable-dynamic-expert-update`, которых в апстрим-декларации SGLang нет. В документации KTransformers `--kt-num-gpu-experts` описан как число GPU-экспертов **на слой**, домножаемое на количество MoE-слоев, с выбором конкретных экспертов по стратегии. Описанная выше семантика «первые `N` физических id» подтверждается кодом апстрим-checkout'а SGLang; какая из двух действует в вашей сборке, определяется установленной парой `sglang-kt` + `kt-kernel`, и проверяется по `--help` установленного движка (наличие `--kt-expert-placement-strategy` — признак форка).

## Значения и формат

- Целое. `0` означает «ни одного маршрутизируемого эксперта на GPU»: маска отправляет на CPU все id, а `gpu_method.create_weights` получает `num_experts=0`. Отдельной проверки этого случая в апстрим-коде нет, а измерения KTransformers для доли 0% сняты на форке с маской экспертов — на связке из этого checkout'а вырожденный случай стоит проверить на своей сборке.
- `N` больше числа экспертов слоя эквивалентно «все на GPU»: маскировать будет нечего, но CPU-обертка все равно создается и подключается — смысла в такой конфигурации нет.
- `-1` — не используйте. Загрузчик весов трактует его как «не пропускать ни одного эксперта», но `mask_cpu_expert_ids` при этом обнулит **все** идентификаторы (`topk_ids >= -1` истинно всегда), и GPU-часть не посчитает ничего.
- Значение применяется к каждому MoE-слою одинаково; в апстрим-коде нет ни распределения бюджета по слоям, ни выбора «горячих» экспертов.
- Требуемые CPU-веса от значения не зависят: `--kt-weight-path` должен содержать всех экспертов, kt-kernel сам решает, какие считать.

## Когда использовать

- Подбирайте по остатку VRAM: увеличивайте `N`, пока модель, KV-кеш (`--mem-fraction-static`) и CUDA graph помещаются в память карты.
- Уменьшайте `N`, когда старт падает с OOM или когда не хватает памяти под нужный контекст: это первая ручка, которую называет и troubleshooting kt-kernel (рядом с `--mem-fraction-static`, `--chunked-prefill-size`, `--max-total-tokens`).
- Не увеличивайте `N`, если узкое место — пропускная способность CPU по памяти: сначала измерьте, где стоит время (CPU-часть или GPU-часть), иначе прирост VRAM ничего не купит.
- Не оставляйте аргумент незаданным: при включенном KT это ошибка конфигурации, а не «авто».

## Влияние на производительность и память

- **VRAM.** Прямая линейная экономия: в память карты попадают веса только `N` экспертов на слой. Это единственный `--kt-*` аргумент, который заметно двигает VRAM.
- **Latency и throughput.** Чем больше экспертов на GPU, тем меньше работы у CPU и короче ожидание в `sync_forward`. Измерения KTransformers на Qwen3-Next-80B-A3B (4×RTX 4090, Xeon Gold 6454S, TP 4, ShareGPT) показывают рост throughput с ~53 tokens/s при 0% экспертов на GPU до ~112 tokens/s при 100%; эти числа сняты для форка со стратегиями размещения, а не для «первых N id».
- **RAM хоста.** Практически не меняется: CPU-веса грузятся целиком независимо от `N`.
- **Взаимодействие с TP.** GPU-часть шардируется тензорным параллелизмом, CPU-часть — нет: `moe_intermediate_size` для kt-kernel передается полным, а обертка активна только на ранге 0. При росте `--tp-size` имеет смысл поднимать и `N` — в туториале MiniMax-M3 рекомендованы 2-8 экспертов при TP 1, 20-40 при TP 4 и 40-60 при TP 8.
- **CUDA graph.** Захваченные размеры батча передаются в kt-kernel (`KTMoEWrapper.set_capture_batch_sizes` в `decode_cuda_graph_runner.py`), и под каждый из них резервируются pinned-буферы на хосте и выходные тензоры на GPU. Значение `N` на это не влияет, но набор захватываемых батчей влияет.

## Взаимодействие с другими аргументами

- `--kt-weight-path`: без него значение не читается.
- `--mem-fraction-static`: делят одну и ту же VRAM. Сначала фиксируйте `N` по весам, затем подбирайте долю под KV-кеш.
- `--kt-max-deferred-experts-per-token`: уменьшает наблюдаемую задержку CPU-части, но не уменьшает объем CPU-работы; это дополнение к `N`, а не замена.
- `--tp-size`: см. выше — масштабирует GPU-часть и не масштабирует CPU-часть.
- `--chunked-prefill-size`, `--max-total-tokens`: конкурируют за ту же VRAM при prefill и под KV-кеш.

## Типовые проблемы и диагностика

- CUDA OOM при загрузке весов или при захвате CUDA graph — уменьшайте `N`, затем `--mem-fraction-static`.
- Ошибка сравнения `None` с числом в `mask_cpu_expert_ids` или в загрузчике весов — аргумент не задан при включенном KT.
- GPU почти простаивает, CPU занят на 100% — `N` слишком мал для вашей карты.
- CPU простаивает, VRAM на пределе — `N` слишком велик, гибридный режим не дает выигрыша.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).
- В arriero preflight требует, чтобы был задан `--kt-num-gpu-experts` (или форковый `--kt-gpu-experts-ratio`) и чтобы значение было неотрицательным целым; при отсутствии обоих создание/старт инстанса блокируется.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-INT8 --kt-method AMXINT8 --kt-cpuinfer 64 --kt-threadpool-count 2 --kt-num-gpu-experts 32
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1 --kt-weight-path /models/DeepSeek-R1-INT4 --kt-method AMXINT4 --kt-cpuinfer 60 --kt-threadpool-count 2 --kt-num-gpu-experts 8 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `ktransformers/kt-kernel/python/experts.py`
- `ktransformers/kt-kernel/python/experts_base.py`
- `ktransformers/kt-kernel/README.md`
- `ktransformers/doc/en/kt-kernel/experts-sched-Tutorial.md`
- `ktransformers/doc/en/kt-kernel/MiniMax-M3-Tutorial.md`
- arriero: `docs/KTRANSFORMERS_SUPPORT.md`, `docs/RESOURCE_MANAGEMENT.md`
