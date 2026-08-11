---
schema: 1
engine: sglang
primaryName: "--speculative-num-draft-tokens"
title: "--speculative-num-draft-tokens"
summary: Ширина верификационного батча: сколько позиций на каждый выполняющийся запрос target-модель проверяет за один forward. Именно это число умножает decode-батч и определяет потолок ускорения.
group: spec
related:
  - --speculative-algorithm
  - --speculative-num-steps
  - --speculative-eagle-topk
  - --speculative-dflash-block-size
  - --speculative-dspark-block-size
  - --speculative-ngram-external-sam-budget
  - --max-running-requests
  - --cuda-graph-max-bs-decode
  - --mem-fraction-static
  - --page-size
---

# --speculative-num-draft-tokens

## Кратко

`--speculative-num-draft-tokens` — размер окна верификации. Target-модель на каждом decode-шаге прогоняет ровно `bs · num_draft_tokens` позиций: одну на корневой (bonus) токен и `num_draft_tokens − 1` на предложенные черновиком. Это одновременно и потолок ускорения (`accept len` не может превысить `num_draft_tokens`), и множитель стоимости: неудачное предложение оплачивается полной шириной окна. Механика самой спекуляции определяется `--speculative-algorithm`; здесь речь только о ширине проверки.

## Оригинальная справка

```text
The number of tokens sampled from the draft model in Speculative Decoding.
```

## Паспорт аргумента

- Флаги: `--speculative-num-draft-tokens`
- Группа: `spec`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `choices` нет. Минимум — `2` (корень плюс один кандидат); практический потолок — десятки, дальше верификация становится дороже выигрыша
- Значение по умолчанию: `null` — «подберёт движок»
- Эффективное значение: переопределяется почти всегда. При `--speculative-eagle-topk 1` жёстко становится `num_steps + 1`; EAGLE/EAGLE3/STANDALONE без явных значений получают `4` или `8` из `_auto_choose_speculative_params`; NGRAM — `12`; DFLASH — `--speculative-dflash-block-size` либо `block_size` из конфига черновика, иначе `16`; DSPARK — `gamma + 1`; `--speculative-adaptive` — `num_steps + 1`
- Где объявлен: `ServerArgs.speculative_num_draft_tokens`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `handle_speculative_decoding` → выделение KV-пула и `req_to_token` → захват CUDA graph target-verify и draft-extend → forward

## Что меняет в движке

Значение — это ширина фазы `target_verify` (`resolve_num_tokens_per_req(phase="target_verify")` в `sglang/python/sglang/srt/speculative/spec_utils.py`) и фазы `draft_extend`. Из него следует всё остальное:

- **Отбор кандидатов.** `organize_draft_results` (`sglang/python/sglang/srt/speculative/eagle_utils.py`) делает `torch.topk(score_list, num_draft_tokens − 1)` по всему множеству кандидатов, накопленному за `num_steps` шагов черновика. Дерево строится из победителей глобально, а не по уровням: при `topk > 1` длинная маловероятная ветка проигрывает короткой уверенной.
- **Маска дерева.** `build_tree_kernel_efficient` в режиме `FULL_MASK` (по умолчанию на GPU) выделяет булев тензор длиной `seq_lens_sum · num_draft_tokens + num_draft_tokens² · bs`. Первое слагаемое линейно и по длине контекста, и по ширине окна.
- **Резерв KV.** `get_alloc_len_per_decode` возвращает `max(num_steps · topk, num_draft_tokens)`, а `get_alloc_reserve_per_decode` удваивает его; `get_req_to_token_extra_context_len` добавляет каждой строке `req_to_token` запас `4 + num_draft_tokens` сверх длины контекста.
- **CUDA graph.** Verify-граф захватывается на `max_bs · num_draft_tokens` токенов; при `--disaggregation-mode decode` эта же величина попадает в автоподбор `--mem-fraction-static` (`activation_tokens = max_running_requests · num_draft_tokens`). Через `cutedsl_moe_max_num_tokens` она же задаёт бюджет CuteDSL-MoE.

Автоподбор при незаданном значении делает `_handle_eagle_family`, и только вместе с двумя другими числами: если `speculative_num_steps` не задан, а `num_draft_tokens` задан — срабатывает `assert` и старт падает.

Под NGRAM значение работает иначе: дерево-предложение приходит из CPU-структуры и **дополняется нулями до ровно `num_draft_tokens` узлов** (`fillResult` в `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/result.cpp`). Даже когда корпус не дал ни одного совпадения, decode-батч всё равно раздут в `num_draft_tokens` раз.

## Значения и формат

- Целое ≥ 2. `1` формально проходит argparse, но означает «дерево из одного корня» — эквивалент обычного decode.
- Отдельного «авто» нет: не задавать аргумент — и есть авто.
- При `--speculative-eagle-topk 1` значение игнорируется и заменяется на `num_steps + 1` с предупреждением в логе. Единственный способ управлять шириной линейной цепочки — менять `--speculative-num-steps`.
- При `topk > 1` действует необъявленное ограничение: `num_draft_tokens − 1 ≤ topk + (num_steps − 1) · topk²`. Проверки на старте нет, нарушение всплывает как ошибка `torch.topk` под нагрузкой.
- DFLASH: значение должно совпадать с `--speculative-dflash-block-size`, если задано и то и другое, иначе `ValueError`.
- DSPARK: должно равняться `gamma + 1` и быть ≥ 2, иначе `ValueError: DSpark speculative_num_draft_tokens must equal gamma + 1`.
- Для гибридных mamba-моделей действует `assert mamba_track_interval >= speculative_num_draft_tokens`.

## Когда использовать

- Когда `accept len` в логе близок к `num_draft_tokens` — окно упирается в потолок, есть смысл расширить (вместе с `--speculative-num-steps`/`--speculative-eagle-topk`).
- Когда `accept rate` низкий, а latency выросла — окно шире, чем модель способна угадать. Сузьте: пустые позиции стоят полного forward.
- Под NGRAM — это основная ручка компромисса: `12` по умолчанию, `16` в примере апстрима; на неповторяющемся тексте каждый лишний токен окна — чистый убыток.
- Не увеличивать «на всякий случай» при большой конкурентности: decode-батч и так насыщает GPU, а окно умножает его ширину на каждый запрос.

## Влияние на производительность и память

- VRAM: линейно растут маска дерева (`seq_lens_sum · num_draft_tokens` булей на батч), verify-граф (`max_bs · num_draft_tokens` токенов), запас строк `req_to_token` (`4 + num_draft_tokens` на запрос) и KV-переаллокация (`2 · max(num_steps · topk, num_draft_tokens)` слотов на запрос на шаг).
- Compute: target-forward на decode-шаге считает `bs · num_draft_tokens` позиций вместо `bs`. Это самая дорогая часть спекуляции и главная причина, по которой она невыгодна на больших батчах.
- Время старта: verify-граф захватывается на большее число токенов — захват дольше.
- Latency: при высокой acceptance rate падает (за один forward принимается несколько токенов), при низкой растёт.
- RAM хоста: не влияет; для NGRAM host-структура зависит от `--speculative-ngram-capacity`, а не от ширины окна.

## Взаимодействие с другими аргументами

- `--speculative-num-steps` и `--speculative-eagle-topk`: задаются только все три сразу; при `topk = 1` это число вычисляется из шагов, при `topk > 1` — ограничено размером множества кандидатов.
- `--speculative-algorithm`: определяет, откуда берётся значение по умолчанию и какие проверки применяются.
- `--speculative-dflash-block-size` / `--speculative-dspark-block-size`: алгоритм-специфичные псевдонимы этой же величины (`block_size` и `gamma + 1` соответственно).
- `--speculative-ngram-external-sam-budget`: обязан быть `≤ num_draft_tokens − 1`; бюджет внешнего корпуса вычитается из тех же слотов дерева.
- `--max-running-requests`: общий объём верификации — `max_running_requests · num_draft_tokens` токенов; при включённой спекуляции значение по умолчанию — `48`.
- `--cuda-graph-max-bs-decode`: вместе с этим числом задаёт максимальную ширину захваченного verify-графа.
- `--mem-fraction-static`: в режиме `--disaggregation-mode decode` ширина окна прямо входит в автоподбор доли статики.
- `--page-size`: при `topk > 1` и `page_size > 1` KV-резерв считается по постраничной формуле, где ширина окна конкурирует с `num_steps · topk`.

## Типовые проблемы и диагностика

- `RuntimeError: selected index k out of range` из `organize_draft_results` — окно шире множества кандидатов. Уменьшите значение или увеличьте `--speculative-num-steps`/`--speculative-eagle-topk`.
- Предупреждение `speculative_num_draft_tokens is adjusted to speculative_num_steps + 1 when speculative_eagle_topk == 1` — заданное значение отброшено.
- `DSpark speculative_num_draft_tokens must equal gamma + 1 (= N for gamma=M)` — значение не согласовано с `--speculative-dspark-block-size` или с `block_size` из конфига черновика.
- `Both --speculative-num-draft-tokens and --speculative-dflash-block-size are set but they differ` — та же рассогласованность для DFLASH.
- Ускорения нет, `accept len` около `1.0` при широком окне — черновик не попадает; окно только увеличивает стоимость. Начните с `--speculative-num-draft-tokens 4` и `--speculative-eagle-topk 1`.
- OOM на `Capture cuda graph` сразу после расширения окна — verify-граф вырос. Уменьшите `--cuda-graph-max-bs-decode` или `--mem-fraction-static`.
- Чем подтвердить: дамп `server_args=` при старте, строки `Decode batch, … accept len: …, accept rate: …`, и на уровне запроса — `meta_info.spec_accept_length` (`completion_tokens / spec_verify_ct`, включает bonus-токен) и `meta_info.spec_num_proposed_drafts` (`spec_verify_ct · (num_draft_tokens − 1)`).

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --speculative-algorithm EAGLE --speculative-draft-model-path lmsys/sglang-EAGLE-LLaMA3-Instruct-8B --speculative-num-steps 3 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 16 --speculative-ngram-max-bfs-breadth 10 --mem-fraction-static 0.7
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/eagle_utils.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/srt/speculative/ngram_worker.py`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/result.cpp`
- `sglang/python/sglang/srt/mem_cache/allocation_sizing.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
