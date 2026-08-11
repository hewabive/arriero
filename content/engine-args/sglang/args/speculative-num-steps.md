---
schema: 1
engine: sglang
primaryName: "--speculative-num-steps"
title: "--speculative-num-steps"
summary: Глубина цепочки чернового прогноза — сколько раз за один decode-шаг вызывается draft-модель и на сколько токенов вперёд она уходит. Задаётся только вместе с `--speculative-eagle-topk` и `--speculative-num-draft-tokens`.
group: spec
related:
  - --speculative-algorithm
  - --speculative-eagle-topk
  - --speculative-num-draft-tokens
  - --speculative-adaptive
  - --speculative-adaptive-config
  - --speculative-draft-attention-backend
  - --page-size
  - --max-running-requests
  - --mem-fraction-static
---

# --speculative-num-steps

## Кратко

`--speculative-num-steps` — глубина спекуляции: максимальная длина цепочки токенов, которую draft-модель успевает построить до одной проверки target-моделью. Механику самого спекулятивного декодирования задаёт `--speculative-algorithm`; этот аргумент отвечает только за то, насколько глубоко уходит черновик. Вместе с `--speculative-eagle-topk` он определяет размер множества кандидатов (`topk + (num_steps − 1) · topk²`), из которого затем отбираются `--speculative-num-draft-tokens − 1` токенов на проверку, и вместе с ними же задаёт KV-переаллокацию на каждый шаг декодирования. Правило SGLang: либо все три числа не заданы (движок подберёт), либо все три заданы явно.

## Оригинальная справка

```text
The number of steps sampled from draft model in Speculative Decoding.
```

## Паспорт аргумента

- Флаги: `--speculative-num-steps`
- Группа: `spec`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `choices` нет. Практический диапазон — 1…8; `0` осмысленно только при `--speculative-adaptive` (черновик отключён, остаётся обычный decode)
- Значение по умолчанию: `null` — «подберёт движок»
- Эффективное значение: определяется в `handle_speculative_decoding` (`sglang/python/sglang/srt/arg_groups/speculative_hook.py`) по-разному для каждого алгоритма: EAGLE/EAGLE3/STANDALONE — `_auto_choose_speculative_params`; DFLASH и DSPARK — принудительно `1`; NGRAM — `num_draft_tokens // eagle_topk`; `--speculative-adaptive` — средний элемент `candidate_steps`
- Где объявлен: `ServerArgs.speculative_num_steps`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `handle_speculative_decoding` → создание spec-воркера и draft-attention-бэкендов → выделение KV-пула (через `get_alloc_len_per_decode`) → захват CUDA graph draft-decode → forward

## Что меняет в движке

За один decode-шаг spec-воркер (`sglang/python/sglang/srt/speculative/eagle_worker_v2.py`) делает ровно `num_steps` проходов draft-модели:

- `num_steps − 1` проходов внутри `draft_forward` — цикл `for i in range(num_steps)` строит уровень дерева и прерывается `break` перед прогоном на последней итерации;
- один проход `_draft_extend_for_decode` после верификации — он дописывает draft-KV для принятых токенов и готовит `topk_p`/`topk_index` для нулевого уровня следующего шага.

Каждый уровень добавляет одну позицию в глубину: максимальная глубина предложенной цепочки равна `num_steps`, а корнем дерева служит bonus-токен предыдущей верификации. Отсюда прямое следствие для линейной цепочки: при `--speculative-eagle-topk 1` движок **принудительно** выставляет `speculative_num_draft_tokens = speculative_num_steps + 1` и пишет в лог `speculative_num_draft_tokens is adjusted to speculative_num_steps + 1 when speculative_eagle_topk == 1`.

Автоподбор при незаданном значении (`_auto_choose_speculative_params`, только EAGLE/EAGLE3/STANDALONE) возвращает тройку `(num_steps, topk, num_draft_tokens)`:

- `STANDALONE` → `(3, 1, 4)`;
- `LlamaForCausalLM`, `Grok1ForCausalLM`, `Grok1VForCausalLM` → `(5, 4, 8)`;
- DeepSeek V2/V3/V3.2, `GptOssForCausalLM`, GLM4-MoE, BailingMoE, MistralLarge3, Pixtral, MiMoV2 → `(3, 1, 4)`;
- всё остальное → `(3, 1, 4)`.

Автоподбор включается только если `speculative_num_steps is None`, и первым делом проверяет `assert speculative_eagle_topk is None and speculative_num_draft_tokens is None`. То есть задать один `--speculative-num-draft-tokens`, не задав шаги, нельзя — старт падает голым `AssertionError` без текста.

Значение читают дальше: `DraftBackendFactory` (создаёт по одному attention-бэкенду на шаг черновика), `EAGLEDraftCudaGraphRunner` (буфер `out_cache_loc` размера `max_bs · topk · num_steps`), `get_alloc_len_per_decode` (`sglang/python/sglang/srt/mem_cache/allocation_sizing.py`) и адаптивный контроллер.

## Значения и формат

- Целое. Отрицательное argparse примет, дальше поведение не определено — не используйте.
- `1` — минимальная осмысленная глубина для EAGLE: один уровень черновика, `num_draft_tokens = 2` при topk=1. Это режим «один спекулятивный токен на проверку».
- `0` — черновик не строится: `_build_trivial_verify_input` собирает дерево из одного узла, верификация вырождается в обычный decode. Штатно используется только адаптивным режимом на больших батчах; вручную ставить `0` смысла нет.
- «Авто» отдельным значением не выражается: не задавать аргумент — и есть авто.
- При `--speculative-adaptive` значение обязано входить в `candidate_steps` из JSON-конфига (`--speculative-adaptive-config`); в конфиге по умолчанию объединение кандидатов — `{0, 1, 3, 7}`, иначе `ValueError: --speculative-num-steps=… is not in the adaptive config candidate_steps`.
- DFLASH и DSPARK поддерживают только `1`: другое значение не отвергается, а молча понижается с предупреждением `DFLASH only supports speculative_num_steps == 1; overriding …`.
- Под NGRAM аргумент почти всегда не нужен: если его не задать, он вычисляется как `speculative_num_draft_tokens // speculative_eagle_topk`, где topk уже перезаписан значением `--speculative-ngram-max-bfs-breadth`.

## Когда использовать

- Когда `accept len` в логе устойчиво близок к своему потолку (`num_draft_tokens`) — черновик угадывает всю цепочку, и глубину есть смысл увеличить на 1–2.
- Когда `accept rate` низкий (< 0.3) при батче из одного-двух запросов — глубина не окупается: draft-проходы стоят времени, а принимается один токен. Уменьшайте шаги.
- Когда воспроизводите конфигурацию из апстрим-бенчмарка: там всегда указаны все три числа сразу.
- Не трогать при `--speculative-algorithm DFLASH`/`DSPARK` — значение всё равно будет `1`.
- Не трогать «ради экономии VRAM» в одиночку: KV-переаллокация считается как `max(num_steps · topk, num_draft_tokens)`, и уменьшение шагов без уменьшения `--speculative-num-draft-tokens` не даст ничего.

## Влияние на производительность и память

- VRAM, KV-пул: на каждый выполняющийся запрос на каждом decode-шаге резервируется `2 · max(num_steps · topk, num_draft_tokens)` слотов KV (`get_alloc_reserve_per_decode`); двойка — двойная буферизация под overlap-режим. При `page_size > 1` и `topk > 1` формула переходит в `ceil((page_size − 1 + num_steps) / page_size) · page_size · topk`, то есть растёт быстрее.
- VRAM, CUDA graph: draft-decode граф захватывается на ширину `max_bs · topk` токенов, а буфер `out_cache_loc` внутри графа имеет размер `max_bs · topk · num_steps`. Плюс по одному экземпляру метаданных attention-бэкенда на шаг.
- Время старта: каждый шаг — отдельный draft attention backend и отдельный слой захвата графа; увеличение шагов заметно удлиняет `Capture cuda graph`.
- Latency при малом батче: `num_steps` проходов draft-модели добавляются к каждому decode-шагу. Выигрыш есть, только если принято больше токенов, чем стоили эти проходы.
- Throughput при большом батче: спекуляция систематически проигрывает — target-forward и так насыщен, а верификация раздувает батч в `num_draft_tokens` раз. Это и есть причина, по которой адаптивный режим опускает шаги до нуля на больших батчах.
- RAM хоста: не влияет.

## Взаимодействие с другими аргументами

- `--speculative-eagle-topk`: множество кандидатов равно `topk + (num_steps − 1) · topk²`. При `topk = 1` число draft-токенов жёстко становится `num_steps + 1`.
- `--speculative-num-draft-tokens`: при `topk > 1` обязано выполняться `num_draft_tokens − 1 ≤ topk + (num_steps − 1) · topk²` — иначе `torch.topk` в `organize_draft_results` падает уже под нагрузкой, а не на старте.
- `--speculative-algorithm`: определяет, применяется ли автоподбор вообще (EAGLE/EAGLE3/STANDALONE) и не переопределяется ли значение принудительно (DFLASH, DSPARK, NGRAM).
- `--speculative-adaptive` / `--speculative-adaptive-config`: превращают значение в стартовую точку внутри списка кандидатов, дальше шаги меняются на ходу по измеренной acceptance rate.
- `--page-size`: при `page_size > 1` и `topk > 1` глубина попадает в постраничное округление KV-резерва.
- `--max-running-requests`: при включённой спекуляции движок сам ставит `48`, если аргумент не задан (`Max running requests is reset to 48 for speculative decoding`). Резерв KV умножается на это число.
- `--mem-fraction-static`: KV-переаллокация вычитается из того же пула; при глубокой спекуляции пул под обычный контекст сокращается.
- `--speculative-draft-attention-backend`: применяется ко всем `num_steps` шагам черновика сразу.

## Типовые проблемы и диагностика

- Голый `AssertionError` из `_handle_eagle_family` сразу после разбора CLI — задан `--speculative-num-draft-tokens` и/или `--speculative-eagle-topk` без `--speculative-num-steps`. Задайте все три.
- `RuntimeError: selected index k out of range` из `torch.topk` при первом же запросе — `num_draft_tokens − 1` больше размера множества кандидатов. Увеличьте `--speculative-num-steps` или `--speculative-eagle-topk`, либо уменьшите `--speculative-num-draft-tokens`.
- В логе `speculative_num_draft_tokens is adjusted to speculative_num_steps + 1 when speculative_eagle_topk == 1` — заданное число draft-токенов проигнорировано, потому что цепочка линейная. Это норма, но проверьте, что вы этого и хотели.
- `DFLASH only supports speculative_num_steps == 1; overriding speculative_num_steps=… to 1` / та же строка для DSpark — значение молча понижено.
- `torch.OutOfMemoryError` на `Capture cuda graph` после увеличения шагов — растут и `out_cache_loc`, и метаданные attention на шаг. Уменьшите `--cuda-graph-max-bs-decode` или `--mem-fraction-static`.
- Чем подтвердить принятое значение: итоговый дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) — там уже разрешённое число; и строки `Decode batch, … accept len: X.XX, accept rate: Y.YY` из `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`. `accept len` — среднее число токенов, полученных за одну верификацию, **включая гарантированный bonus-токен**: `1.00` означает «спекуляция не даёт ничего». `accept rate` — доля принятых из предложенных: `(принято − число верификаций) / (число верификаций · (num_draft_tokens − 1))`. Накопленное с момента старта значение отдаёт `GET /get_server_info` в поле `avg_spec_accept_length`, а на запрос — `meta_info.spec_accept_length` и `meta_info.spec_accept_rate`.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --speculative-algorithm EAGLE --speculative-draft-model-path lmsys/sglang-EAGLE-LLaMA3-Instruct-8B --speculative-num-steps 5 --speculative-eagle-topk 4 --speculative-num-draft-tokens 8
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --speculative-algorithm EAGLE --speculative-draft-model-path /models/qwen3-eagle --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --max-running-requests 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`
- `sglang/python/sglang/srt/speculative/eagle_utils.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/srt/speculative/spec_info.py`
- `sglang/python/sglang/srt/speculative/adaptive_spec_params.py`
- `sglang/python/sglang/srt/speculative/eagle_draft_cuda_graph_runner.py`
- `sglang/python/sglang/srt/mem_cache/allocation_sizing.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
