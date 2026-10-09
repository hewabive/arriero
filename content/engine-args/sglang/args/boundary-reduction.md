---
schema: 1
engine: sglang
primaryName: "--boundary-reduction"
title: "--boundary-reduction"
summary: Разрешает FFN-выходу decoder'ов на stage boundaries сводиться через reduce-scatter (`rs`, `rsv`) вместо all-reduce с последующим перераспределением токенов. `auto` подбирает политику по архитектуре до построения модели; эффект есть только при DP attention, input-scattered attention или context parallel prefill.
group: exec.comm
related:
  - --enable-dp-attention
  - --dp-size
  - --tp-size
  - --ep-size
  - --moe-a2a-backend
  - --enable-attn-tp-input-scattered
  - --attn-cp-size
  - --speculative-algorithm
  - --speculative-draft-model-path
  - --enforce-disable-flashinfer-allreduce-fusion
  - --flashinfer-allreduce-fusion-backend
  - --enable-aiter-allreduce-fusion
---

# --boundary-reduction

## Кратко

После FFN-блока (dense MLP или MoE) на TP-рангах лежат частичные суммы. Базовый путь — all-reduce, а затем, если токены надо вернуть «своим» рангам (attention DP, input-scattered attention, context parallel), отдельная раздача строк. Reduce-scatter выполняет сумму и раздачу одним коллективом. Флаг задает, какие варианты reduce-scatter граница слоя **может** выбрать. Это разрешение, а не приказ: если путь не подходит по раскладке, форме или backend'у, используется `ar`.

Действует только на модели, собранные через независимые stage boundaries (`declare_ffn` / `make_stages`). Остальные архитектуры флаг игнорируют. Аргумент новый: появился в upstream PR #41552, поэтому в закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
Select FFN boundary reduction: ar uses all-reduce then token redistribution; rs and rsv permit fixed-size and variable-size reduce-scatter respectively; rs+rsv permits both (RSv first). Unsupported paths fall back to ar. The option applies to the FFN stages of decoders built with stage boundaries, where auto resolves the model default; other models ignore it. Required attention and MoE collectives and all-reduce fusion are unaffected.
```

## Паспорт аргумента

- Флаги: `--boundary-reduction`
- Группа: `exec.comm`
- Тип значения: строка из фиксированного списка (`Literal` в объявлении → `choices` у argparse)
- Допустимые значения: `auto`, `ar`, `rs`, `rsv`, `rs+rsv`
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` переписывается проходом `resolve_boundary_reduction` (`arg_groups/boundary_reduction.py`) в одну из четырех конкретных политик по `architectures` HF-конфига. Тот же проход заполняет поле `speculative_boundary_reduction` для draft-модели: у него нет CLI-флага, и независимое значение затирается. Явное значение копируется в оба поля без изменений
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecComm.boundary_reduction`; поле помечено `resolvable=True`
- Статус: обычный, новый
- Этап применения: разбор CLI → пайплайн разрешения (сразу после `handle_speculative_decoding`, чтобы алгоритм и путь draft'а были окончательными; для `--model-path dummy` — сразу после аппаратных проверок) → построение модели (`layers/layer_boundary/factories.py:_ffn_decl` записывает разрешения в декларацию FFN-стадии) → каждый forward (выбор коллектива в `layers/layer_boundary/exit.py`)

## Что меняет в движке

### Как разрешается `auto`

`model_boundary_reduction(config)` смотрит на `architectures`:

- `rsv` — `BailingMoELinearForCausalLM`, `BailingMoeV2_5ForCausalLM`, `LongcatFlashForCausalLM`, `LongcatFlashForCausalLMNextN`, `Step3VLForConditionalGeneration`;
- `ar` — dense Qwen3 (`Qwen3ForCausalLM`, `Qwen3ForSequenceClassification`, `Qwen3Model`, `Qwen3ForRewardModel`, а также `model_type` `qwen3`/`qwen3_vl_text`, то есть backbone Qwen3-VL), `MossVLForCausalLM`/`MossVLForConditionalGeneration`, MiniCPM-V 4.5;
- для оберток правило применяется к вложенному `get_text_config()`, `text_config`, `llm_config` или `language_config`;
- все остальное — `rs+rsv`. Qwen3-MoE, Qwen3-Next и Qwen3.5 под правило dense Qwen3 не попадают и получают `rs+rsv`.

`--model-path dummy` / `none` получает `rs+rsv`.

Draft-модель при `auto`: если `--speculative-draft-model-path` указывает на другой путь, ее конфиг читается отдельно (`get_config` с `--speculative-draft-model-revision` и `--json-model-override-args`), и она получает собственную политику. MTP-draft на пути целевой модели наследует политику цели. Draft строится внутри `draft_model_build_scope` (`layers/moe/utils.py`), который на время построения подставляет `speculative_boundary_reduction`.

### Что разрешает каждое значение

`_ffn_decl` переводит политику в два признака декларации FFN-выхода. `leaves_for_reduce_scatter` ставится для `rs` и `rs+rsv`, `leaves_for_reduce_scatterv` — для `rsv` и `rs+rsv`. Оба снимаются, если у стадии есть `output_transform`, который нельзя перенести до reduce-scatter. Признак означает, что FFN не делает собственный all-reduce и оставляет частичную сумму границе.

На каждом forward `_reduce_and_redistribute_output_step` выбирает путь:

1. **RSv** — `reduce_scatterv` по TP-группе с переменными долями по DP-рангам. Нужно, чтобы путь был разрешен и выполнялось `should_use_dp_reduce_scatterv()`: DP attention с `attn_dp_size > 1`, `tp_size == attn_dp_size` (attention TP = 1), `moe_ep_size == attn_dp_size`, `--moe-a2a-backend none` и неактивный FP4-all-gather FlashInfer CUTLASS.
2. **Fixed-size reduce-scatter** — если путь разрешен, батч в режиме DP-паддинга `max_len` и TP-группа покрывает раскладку DP × attention TP (`can_use_dp_reduce_scatter`).
3. Иначе all-reduce и раздача строк (`ar`).

Помимо attention DP, reduce-scatter участвует в варианте input-scattered attention (`--enable-attn-tp-input-scattered` при чистом TP, без DP attention и без a2a backend'а) и в context parallel prefill, где перемещение по CP имеет свой reduce-scatter. В обычном TP без этих режимов токены никуда не перераспределяются, и FFN-выход сводится all-reduce при любом значении флага.

### Чего флаг не трогает

Обязательные коллективы внимания и MoE (включая expert all-to-all) и выбор all-reduce fusion — отдельные механизмы. `ar` не выключает слияние all-reduce с residual + RMSNorm: для FlashInfer за это отвечает `--enforce-disable-flashinfer-allreduce-fusion`, для ROCm — `--enable-aiter-allreduce-fusion`.

Архитектуры без `declare_ffn`/`make_stages` (например DeepSeek-V4 со своим `models/deepseek_v4.py`) флаг не читают. Полный перечень — файлы в `python/sglang/srt/models/`, где встречаются эти вызовы. В checkout'е среди них DeepSeek-V2/V3 (`deepseek_v2.py`), GLM-4 MoE, Qwen2-MoE, Qwen3, Qwen3-MoE, Qwen3-Next, Qwen3.5, GPT-OSS, Llama 4, MiniMax-M2/M3, LongCat Flash, Step3-VL, Step3p5 и семейство Bailing.

## Значения и формат

- `auto` — подбор по архитектуре (см. выше); в итоговой конфигурации `auto` не остается.
- `ar` — только all-reduce и перераспределение строк там, где оно нужно.
- `rs` — разрешен fixed-size reduce-scatter.
- `rsv` — разрешен variable-size reduce-scatter для attention-DP пути.
- `rs+rsv` — разрешены оба; сначала пробуется RSv, затем fixed-size, затем `ar`.
- Значение вне списка отвергает argparse.
- `ValueError: boundary_reduction must be resolved before model construction` означает, что модель строится в обход пайплайна разрешения. При обычном `python -m sglang.launch_server` эта ошибка не возникает.

## Когда использовать

- На DP attention с MoE после обновления появился регресс, зависание коллектива или численное расхождение. `--boundary-reduction ar` возвращает самый простой путь и служит контрольной точкой для A/B.
- Профилирование коммуникаций: сравнить `rs`, `rsv` и `rs+rsv` на своей топологии, если автоподбор кажется неоптимальным.
- Не трогайте на одной GPU и на чистом TP без DP attention, input-scattered attention и context parallel — эффекта нет.
- arriero: квалифицированный профиль KTransformers работает на одной GPU (`docs/KTRANSFORMERS_OPERATIONS.md`), TP-коллективов там нет, флаг инертен.

## Влияние на производительность и память

- **VRAM.** Отдельных буферов флаг не выделяет; размер KV-пула не меняется.
- **Коммуникации.** В кольцевой реализации reduce-scatter передает примерно половину объема all-reduce, а последующая раздача строк становится не нужна. RSv дополнительно избегает паддинга до максимального числа токенов среди DP-рангов. Реальный выигрыш зависит от формы батча и линков; измеряйте.
- **Численный результат.** Порядок суммирования у коллективов разный, поэтому возможны побитовые расхождения выхода между значениями флага.
- **Время старта.** При `auto` с draft-моделью на отдельном пути добавляется чтение ее конфига; это быстро.

## Взаимодействие с другими аргументами

- `--enable-dp-attention`, `--dp-size`, `--tp-size`: RSv требует attention TP = 1, то есть `tp_size == dp_size` при DP attention.
- `--ep-size`, `--moe-a2a-backend`: RSv нужен `moe_ep_size == attn_dp_size` и `--moe-a2a-backend none`. С a2a backend'ом MoE-вход уже разложен по DP-рангам, и sparse FFN-выход остается локальным.
- `--enable-attn-tp-input-scattered`: включает input-scattered вариант, где `rs` сводит выход под следующий вход.
- `--attn-cp-size`: context parallel prefill использует свой reduce-scatter и тоже учитывает разрешение `rs`.
- `--speculative-algorithm`, `--speculative-draft-model-path`: определяют, получит ли draft собственную политику при `auto`.
- `--enforce-disable-flashinfer-allreduce-fusion`, `--flashinfer-allreduce-fusion-backend`, `--enable-aiter-allreduce-fusion`: fusion управляется отдельно; `ar` его не выключает.

## Типовые проблемы и диагностика

- **Что выбрал `auto`.** Итоговый дамп `server_args=` (`resolved_dict()` в `sglang/python/sglang/srt/entrypoints/engine.py`) показывает уже разрешенные `boundary_reduction` и `speculative_boundary_reduction`.
- **Какой коллектив реально работает.** Построчного лога выбора движок не печатает; смотрите профиль (имена NCCL-ядер `ReduceScatter` против `AllReduce`).
- **Подозрение на коммуникационный баг.** Повторите нагрузку с `--boundary-reduction ar`. Если проблема исчезла, она в reduce-scatter-пути.
- **`unrecognized arguments: --boundary-reduction`.** Установленная сборка старше PR #41552; проверьте `--help` своего окружения.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --tp-size 8 --dp-size 8 --enable-dp-attention --boundary-reduction ar
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --tp-size 8 --dp-size 8 --enable-dp-attention --boundary-reduction rsv
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/boundary_reduction.py`
- `sglang/python/sglang/srt/arg_groups/pipeline.py`
- `sglang/python/sglang/srt/layers/layer_boundary/factories.py`
- `sglang/python/sglang/srt/layers/layer_boundary/exit.py`
- `sglang/python/sglang/srt/layers/layer_boundary/construction.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx` (раздел «FFN boundary reduction»)
- `sglang/docs/docs/developer_guide/layer_boundary.mdx`
- upstream PR #41552 «[Refactor] Construct independent decoder stage boundaries» (коммит `49b5e76e45` в checkout)
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
