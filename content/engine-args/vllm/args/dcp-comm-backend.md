---
schema: 1
engine: vllm
primaryName: "--dcp-comm-backend"
title: "--dcp-comm-backend"
summary: Способ сборки частичных результатов внимания между DCP-рангами: классический allgather + reduce-scatter либо all-to-all с последующим Triton-объединением по LSE. Значим только при `--decode-context-parallel-size` больше единицы.
group: ParallelConfig
related:
  - --decode-context-parallel-size
  - --tensor-parallel-size
  - --prefill-context-parallel-size
  - --cp-kv-cache-interleave-size
  - --dcp-kv-cache-interleave-size
  - --attention-backend
  - --max-num-batched-tokens
---

# --dcp-comm-backend

## Кратко

Когда KV-cache разрезан по DCP-рангам, каждый ранг считает внимание по **своей** доле контекста и получает частичный выход плюс log-sum-exp. Эти куски надо свести в один ответ. `--dcp-comm-backend` выбирает, как именно.

`ag_rs` — исходное поведение: allgather частичных выходов, затем reduce-scatter. `a2a` — обмен all-to-all и объединение Triton-ядром; по справке это снижает число вызовов NCCL с трёх до двух на слой для MLA-моделей.

## Оригинальная справка

```text
Communication backend for Decode Context Parallel (DCP).
- "ag_rs": AllGather + ReduceScatter (default, existing behavior)
- "a2a": All-to-All exchange of partial outputs + LSE, then
  combine with Triton kernel. Reduces NCCL calls from 3 to 2
  per layer for MLA models.
```

## Паспорт аргумента

- Флаги: `--dcp-comm-backend`
- Группа argparse: `ParallelConfig`
- Тип значения: enum (строка)
- Допустимые значения: `ag_rs`, `a2a` (`DCPCommBackend = Literal["ag_rs", "a2a"]`)
- Значение по умолчанию: `ag_rs`
- Эффективное значение: не переопределяется; но `a2a` отвергается валидатором при `--decode-context-parallel-size 1`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.dcp_comm_backend`
- Этап применения: построение метаданных attention-бэкенда → каждый forward слоёв внимания при активном DCP

## Что меняет в движке

Значение читается в трёх местах и всюду сводится к выбору одной функции объединения:

- `vllm/v1/attention/backends/flash_attn.py`: `dcp_a2a = dcp > 1 and dcp_comm_backend == "a2a"`, затем `self.dcp_combine = dcp_a2a_lse_reduce if dcp_a2a else cp_lse_ag_out_rs`;
- `vllm/v1/attention/backends/flashinfer.py`: то же самое и в построителе метаданных (`self.dcp_a2a`), и в реализации (`partial(dcp_a2a_lse_reduce, is_lse_base_on_e=False)` против `partial(cp_lse_ag_out_rs, ...)`);
- `vllm/v1/attention/ops/dcp_utils.py`: `self.use_a2a = parallel_config.dcp_comm_backend == "a2a"` — от него зависит устройство рабочих буферов, объединения и сбора query.

Валидация одна: `dcp_comm_backend='a2a' requires decode_context_parallel_size > 1.` При `dcp == 1` пути объединения нет вообще, поэтому значение `ag_rs` в этом случае просто не используется, а `a2a` считается ошибкой конфигурации.

## Значения и формат

- Строка из двух вариантов; неизвестное значение отвергается.
- «Не задано» = `ag_rs`.
- `a2a` осмыслен только вместе с `-dcp > 1`; выигрыш, заявленный в справке, сформулирован для MLA-моделей, хотя код объединения используется и на пути GQA (`flash_attn`).
- Флаг не влияет на раскладку KV-cache — за неё отвечают `--cp-kv-cache-interleave-size` и `--decode-context-parallel-size`.

## Когда использовать

- `a2a` — на MLA-развертывании с большим DCP, где на каждом слое ощутима стоимость коллективов: два вызова NCCL вместо трёх плюс Triton-объединение.
- `ag_rs` — значение по умолчанию и безопасный откат, если после переключения на `a2a` появились расхождения в качестве или нестабильность.
- Не трогайте, если DCP не включён: без `-dcp > 1` флаг либо инертен, либо приводит к ошибке конфигурации.

## Влияние на производительность и память

- **Latency декодирования.** Единственный предмет флага: меньше коллективов на слой — меньше времени на обмен при том же объёме данных.
- **VRAM.** Оба пути держат рабочие буферы под частичные выходы и LSE; их размер определяется числом голов, `--max-num-batched-tokens` и числом микробатчей, а не выбором бэкенда как таковым.
- **Throughput.** Косвенно, через latency шага декодирования.
- **Время старта.** Triton-ядро объединения компилируется при первом использовании — первые шаги после старта могут быть медленнее.

## Взаимодействие с другими аргументами

- `--decode-context-parallel-size`: обязателен `> 1` для `a2a`.
- `--tensor-parallel-size`, `--prefill-context-parallel-size`: задают допустимые значения DCP, а значит и применимость флага.
- `--cp-kv-cache-interleave-size`: определяет, какие токены лежат на каком ранге, то есть что именно объединяется.
- `--attention-backend`: путь объединения реализован в конкретных бэкендах (`flash_attn`, `flashinfer`); на бэкенде без DCP-поддержки флаг не заработает.
- `--max-num-batched-tokens`: через него считается максимальный размер рабочей области DCP.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: dcp_comm_backend='a2a' requires decode_context_parallel_size > 1.` **Причина:** `a2a` без DCP. **Лечение:** задать `-dcp` или убрать флаг.
- **Симптом:** ошибка валидации значения (`must be one of` / `Input should be`). **Причина:** опечатка. **Лечение:** ровно `ag_rs` или `a2a`.
- **Симптом:** переключение на `a2a` не дало эффекта. **Причина:** выбранный attention-бэкенд не идёт по DCP-пути объединения, либо DCP фактически равен 1. **Лечение:** проверить `decode_context_parallel_size` в стартовой строке конфига и выбранный attention-бэкенд.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `dcp_comm_backend=...` рядом с `decode_context_parallel_size=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --tensor-parallel-size 8 --decode-context-parallel-size 8 --dcp-comm-backend a2a
```

```bash
vllm serve /models/DeepSeek-V2-Lite --tensor-parallel-size 8 --decode-context-parallel-size 4 --dcp-comm-backend ag_rs
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/attention/ops/dcp_utils.py`
- `vllm/vllm/v1/attention/backends/flash_attn.py`
- `vllm/vllm/v1/attention/backends/flashinfer.py`
- `vllm/tests/distributed/test_dcp_a2a.py`
- `vllm/tests/distributed/test_dcp_direct_a2a_lse_reduce.py`
- `vllm/docs/serving/context_parallel_deployment.md`
