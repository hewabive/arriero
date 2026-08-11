---
schema: 1
engine: sglang
primaryName: "--speculative-eagle-topk"
title: "--speculative-eagle-topk"
summary: Ширина ветвления чернового дерева: сколько продолжений draft-модель удерживает на каждом шаге. `1` — линейная цепочка (MTP-стиль), больше единицы — дерево, у которого много жёстких ограничений по attention-бэкенду и `--page-size`.
group: spec
related:
  - --speculative-algorithm
  - --speculative-num-steps
  - --speculative-num-draft-tokens
  - --speculative-use-rejection-sampling
  - --speculative-ngram-max-bfs-breadth
  - --attention-backend
  - --page-size
  - --enable-multi-layer-eagle
  - --speculative-adaptive
  - --enable-unified-memory
  - --enable-linear-replayssm-spec
---

# --speculative-eagle-topk

## Кратко

`--speculative-eagle-topk` — коэффициент ветвления черновика. На нулевом шаге draft-модель берёт `topk` самых вероятных продолжений, на каждом следующем разворачивает их в `topk²` кандидатов и оставляет `topk` лучших по накопленному произведению вероятностей. Значение `1` превращает дерево в линейную цепочку и включает целый набор упрощённых путей; значение больше единицы даёт дерево, которое надо согласовать с `--attention-backend` и `--page-size`. Что именно делает draft-модель, определяет `--speculative-algorithm`; здесь речь только о ширине.

## Оригинальная справка

```text
The number of tokens sampled from the draft model in eagle2 each step.
```

## Паспорт аргумента

- Флаги: `--speculative-eagle-topk`
- Группа: `spec`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `choices` нет. Осмысленный диапазон — 1…8; апстрим-конфигурации используют `1` и `4`
- Значение по умолчанию: `null` — «подберёт движок»
- Эффективное значение: EAGLE/EAGLE3/STANDALONE без явных значений получают `1` или `4` из `_auto_choose_speculative_params`; DFLASH и DSPARK принудительно понижают до `1` с предупреждением; NGRAM **перезаписывает** значение на `--speculative-ngram-max-bfs-breadth`; `--speculative-adaptive` ставит `1`
- Где объявлен: `ServerArgs.speculative_eagle_topk`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `handle_speculative_decoding` (валидации по backend/page_size) → создание draft-воркера → захват CUDA graph draft-decode → forward

## Что меняет в движке

В `draft_forward` (`sglang/python/sglang/srt/speculative/eagle_worker_v2.py`) значение управляет `select_top_k_tokens` (`sglang/python/sglang/srt/speculative/spec_utils.py`):

- шаг 0: из распределения draft-модели берутся `topk` токенов, batch расширяется в `topk` раз (`repeat_interleave`);
- шаг i > 0: `expand_scores = scores · topk_p` даёт `topk × topk` кандидатов на запрос, из них `fast_topk` оставляет `topk` для следующего прогона, но **все** `topk²` попадают в общий пул кандидатов.

Итоговый пул — `topk + (num_steps − 1) · topk²` токенов, из которого `organize_draft_results` отбирает `num_draft_tokens − 1` лучших по накопленному score. Отсюда: ширина покупает разнообразие гипотез при фиксированной глубине, а не большую глубину.

Отдельная ветка — `topk == 1`. Тогда:

- `speculative_num_draft_tokens` принудительно становится `num_steps + 1`;
- в `draft_forward` включается упрощённый путь `draft_tokens_topk1` с предвыделенными буферами `_topk1_parents_prealloc` / `_topk1_score_indices_prealloc` и одним CUDA-ядром `draft_topk1_postprocess` вместо построения дерева;
- KV-резерв считается без постраничного дублирования веток (`get_alloc_len_per_decode` уходит в ветку `page_size == 1 or spec_topk == 1`).

Ширина черновика — это и ширина фазы `draft_decode`: `resolve_num_tokens_per_req(phase="draft_decode")` возвращает ровно `topk`, поэтому draft-decode CUDA graph захватывается на `max_bs · topk` токенов, а буфер `out_cache_loc` внутри него — на `max_bs · topk · num_steps`.

## Значения и формат

- Целое ≥ 1.
- `1` — линейная цепочка. Это режим MTP/NEXTN и единственный, совместимый с `--speculative-use-rejection-sampling`, `--speculative-adaptive`, `--enable-unified-memory`, `--enable-linear-replayssm-spec` и attention-бэкендом `trtllm_mha`.
- `> 1` — дерево. Требует, чтобы при `--page-size` больше единицы attention-бэкенд был одним из `flashinfer`, `fa3`, `triton` (для NGRAM — только `flashinfer`), иначе `ValueError` на старте.
- Отдельного «авто» нет: не задавать аргумент — и есть авто, но только вместе с `--speculative-num-steps` и `--speculative-num-draft-tokens`.
- Под NGRAM аргумент бесполезен: `_handle_ngram` безусловно присваивает `speculative_eagle_topk = speculative_ngram_max_bfs_breadth`, никакого предупреждения при этом не печатается.

## Когда использовать

- `1` — стартовая точка для локального сервера с малым числом одновременных запросов: самый дешёвый черновик, самые предсказуемые ограничения, доступно rejection sampling.
- `4` в паре с `--speculative-num-steps 5 --speculative-num-draft-tokens 8` — конфигурация апстрима для плотных Llama-подобных моделей: дерево окупается, когда draft-модель часто угадывает «почти правильно».
- Увеличивать ширину имеет смысл при низком `accept rate` и коротких принятых цепочках: значит, черновик берёт правильную ветку не с первой попытки.
- Не увеличивать, если у вас `--page-size` больше единицы и attention-бэкенд не из списка выше — старт просто не пройдёт.
- Не трогать при NGRAM: настраивайте `--speculative-ngram-max-bfs-breadth`.

## Влияние на производительность и память

- VRAM, draft-KV: черновик пишет KV для `topk · num_steps` позиций на запрос; резерв — `2 · max(num_steps · topk, num_draft_tokens)` слотов на запрос на decode-шаг. При `page_size > 1` и `topk > 1` каждая ветка округляется до страниц: `ceil((page_size − 1 + num_steps) / page_size) · page_size · topk` — это может оказаться в разы больше, чем `num_steps · topk`.
- VRAM, CUDA graph: draft-decode граф — `max_bs · topk` токенов, буферы `topk_p`/`topk_index` — `(max_bs, topk)`.
- Compute черновика: каждый draft-прогон идёт на батче в `topk` раз шире обычного decode. Это прямая надбавка к latency на каждом шаге.
- Compute верификации: не зависит от ширины напрямую — верификация всегда `num_draft_tokens` позиций.
- Время старта: захват draft-графа на большей ширине — дольше.
- RAM хоста: не влияет.

## Взаимодействие с другими аргументами

- `--speculative-num-steps`: вместе задают пул кандидатов `topk + (num_steps − 1) · topk²`.
- `--speculative-num-draft-tokens`: при `topk = 1` вычисляется как `num_steps + 1`; при `topk > 1` не должен превышать пул кандидатов плюс один.
- `--speculative-use-rejection-sampling`: требует `topk = 1`, иначе `ValueError: --speculative-use-rejection-sampling requires --speculative-eagle-topk=1`.
- `--attention-backend`: `trtllm_mha` не поддерживает `topk > 1` (`trtllm_mha backend only supports topk = 1 for speculative decoding`); `flashmla`, `trtllm_mla`, `cutlass_mla` не умеют выражать поветочное дерево при `--page-size` больше единицы.
- `--page-size`: при `> 1` вместе с `topk > 1` включает двухпроходный cascade-путь и постраничное дублирование KV.
- `--enable-multi-layer-eagle`: в сочетании с rejection sampling также требует `topk = 1`.
- `--enable-unified-memory` и `--enable-linear-replayssm-spec`: оба требуют `topk ∈ {None, 1}`.
- `--speculative-adaptive`: ставит `topk = 1`, если он не задан, и отказывается работать при `topk ≠ 1`.
- `--speculative-ngram-max-bfs-breadth`: под NGRAM полностью замещает этот аргумент.

## Типовые проблемы и диагностика

- `trtllm_mha backend only supports topk = 1 for speculative decoding` — либо поставьте `--speculative-eagle-topk 1`, либо смените `--attention-backend`.
- `speculative_eagle_topk > 1 with page_size > 1 is only supported on ('flashinfer', 'fa3', 'triton')` — несовместимая тройка backend/page_size/ширина.
- `speculative_eagle_topk(N) > 1 with page_size(M) > 1 is unstable and produces incorrect results for paged attention backends` — та же проблема под NGRAM, где допустим только `flashinfer`.
- `--speculative-use-rejection-sampling requires --speculative-eagle-topk=1` — несовместимая пара.
- `DSpark only supports speculative_eagle_topk == 1; overriding …` / та же строка для DFLASH — значение молча понижено.
- Неожиданный расход KV после включения `--page-size 64` при `topk 4` — сработало постраничное дублирование веток; либо верните `--page-size 1`, либо снизьте ширину до `1`.
- Ширина под NGRAM «не применяется» — так и задумано: смотрите в дампе `server_args=`, там будет значение `--speculative-ngram-max-bfs-breadth`.
- Чем подтвердить: дамп `server_args=` при старте и строки `Decode batch, … accept len: …, accept rate: …`; `accept rate` считается от `num_draft_tokens − 1` предложенных на верификацию, поэтому при широком дереве он падает быстрее, чем `accept len`.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path lmsys/sglang-EAGLE3-LLaMA3.1-Instruct-8B --speculative-num-steps 5 --speculative-eagle-topk 4 --speculative-num-draft-tokens 8 --attention-backend fa3
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --speculative-algorithm NEXTN --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/srt/speculative/eagle_utils.py`
- `sglang/python/sglang/srt/speculative/eagle_draft_cuda_graph_runner.py`
- `sglang/python/sglang/srt/mem_cache/allocation_sizing.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
