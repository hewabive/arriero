---
schema: 1
engine: sglang
primaryName: "--dcp-comm-backend"
title: "--dcp-comm-backend"
summary: Способ свести частичные выходы внимания между DCP-рангами: `ag_rs` (совместимый), `a2a` (один NCCL-вызов на слой) или `fi_a2a` (MNNVL-ядро FlashInfer, только GB200-класс).
group: parallel
related:
  - --dcp-size
  - --dcp-replicate-q-proj
  - --attention-backend
  - --tp-size
  - --enable-symm-mem
---

# --dcp-comm-backend

## Кратко

При `--dcp-size > 1` каждый слой decode заканчивается сведением частичных выходов внимания и их LSE по DCP-группе. Этот аргумент выбирает, как именно: `ag_rs` — классическая пара all-gather + reduce-scatter, `a2a` — упакованный all-to-all (выход и LSE в одном NCCL-вызове) с локальным Triton-сведением, `fi_a2a` — тот же обмен, но делегированный MNNVL-ядру FlashInfer, доступному только на фабричном железе класса GB200 NVL72. Значение по умолчанию `ag_rs` работает везде; `a2a` — обычно более быстрый выбор там, где число голов делится на размер группы.

## Оригинальная справка

```text
Communication backend for the decode context-parallel (DCP) attention reduction: 'ag_rs' (AllGather + ReduceScatter), 'a2a' (fused NCCL All-to-All exchange of output+LSE + local Triton LSE combine), or 'fi_a2a' (FlashInfer MNNVL All-to-All kernel; requires SM90+ and MNNVL fabric memory, e.g. GB200 NVL72).
```

## Паспорт аргумента

- Флаги: `--dcp-comm-backend`
- Группа: `parallel`
- Тип значения: str
- Допустимые значения: `ag_rs`, `a2a`, `fi_a2a` (`choices` объявлены)
- Значение по умолчанию: `ag_rs`
- Эффективное значение: поле объявлено `resolvable=True`. Для Kimi-K3 с DCP `arg_groups/overrides.py` **переписывает** значение безусловно: `fi_a2a`, если карта опознана как MNNVL-фабричная (`is_mnnvl_fabric_device()` — имя устройства содержит `GB200`/`GB300`), иначе `a2a`; в лог идет `Kimi-K3 DCP selects communication backend on '<device>': '<старое>' -> '<новое>'.`
- Где объявлен: `ServerArgs.dcp_comm_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: валидация в `_handle_dcp_validation` → предварительное выделение MNNVL-workspace до захвата CUDA graph (только `fi_a2a`) → каждый слой decode

## Что меняет в движке

### ag_rs

`cp_lse_ag_out_rs_mla` (`sglang/python/sglang/srt/layers/dcp/comm.py`): выходы `[B, H, D]` и LSE `[B, H]` собираются по группе, Triton-ядро корректирует softmax-веса с учетом основания логарифма (FlashInfer-MLA отдает LSE по основанию 2, FlashMLA — натуральный; несоответствие пары exp/log дает неверные веса), затем результат раздается обратно. Работает при любом числе голов и на любом транспорте.

### a2a

`dcp_a2a_lse_reduce`: выход и LSE **упаковываются в один тензор** (LSE переинтерпретируется как дополнительные колонки в измерении D) и обмениваются одним `all_to_all_single` — один NCCL-вызов на слой вместо двух. Сведение LSE выполняется локально Triton-ядром. Жесткое требование — делимость: `assert H % N == 0, "num_heads (H) must be divisible by dcp_size (N)"`. Есть отдельная ветка с преаллоцированными буферами для пути CUDA graph.

### fi_a2a

Только межранговый обмен делегируется `flashinfer.comm.dcp_alltoall.decode_cp_a2a_alltoall`; локальное сведение LSE остается тем же Triton-ядром. Требования проверяются в двух местах:

- на этапе разбора аргументов — платформа CUDA, иначе `ValueError: --dcp-comm-backend fi_a2a delegates the exchange to FlashInfer's MNNVL All-to-All kernel, which requires an NVIDIA CUDA platform with SM90+ and MNNVL fabric memory (e.g. GB200 NVL72). The authoritative fabric probe runs at model-runner init; use 'a2a' or 'ag_rs' on clusters without MNNVL.`;
- на инициализации model runner'а — `init_fi_a2a_workspace` (вызывается **до** захвата CUDA graph, потому что синхронизирует поток и делает межранговый барьер): `ImportError: --dcp-comm-backend fi_a2a requires FlashInfer with the DCP all-to-all kernel (flashinfer #2951); could not import flashinfer.comm.dcp_alltoall.` либо `RuntimeError: --dcp-comm-backend fi_a2a requires MNNVL fabric memory (e.g. GB200 NVL72); is_mnnvl_fabric_supported() returned False. Use --dcp-comm-backend a2a or ag_rs on clusters without MNNVL.`

## Значения и формат

- Одна из трех строк; иное значение argparse отвергнет со списком допустимых.
- `ag_rs` — единственное значение, допустимое при `--dcp-size 1` (оно же дефолт и там ни на что не влияет). `a2a` и `fi_a2a` при `dcp_size <= 1` отвергаются на старте.
- `a2a` требует делимости числа голов внимания на `dcp_size`.
- `fi_a2a` требует CUDA, SM90+, MNNVL-фабрики и FlashInfer с соответствующим ядром.
- Значение может быть переписано модельным override'ом (Kimi-K3), и это не ошибка конфигурации — смотрите строку `… selects communication backend …` в логе.

## Когда использовать

- `ag_rs` — безопасный старт и любая конфигурация, где число голов не делится на `dcp_size`.
- `a2a` — обычный рабочий выбор на NVLink-узле при подходящем числе голов: вдвое меньше NCCL-вызовов на слой и меньше трафика, чем у all-gather полного выхода.
- `fi_a2a` — только на GB200/GB300-классе. На прочем железе он отвергается, а не деградирует молча.
- Менять значение имеет смысл, только когда decode-latency упирается в коммуникацию. Измеряйте: разница видна на межтокенной задержке, а не на TTFT.
- На Kimi-K3 задавать значение вручную бессмысленно: override перепишет его в любом случае.

## Влияние на производительность и память

- Latency decode: главный измеряемый эффект. `a2a` экономит один коллектив на слой относительно `ag_rs` и передает меньше данных (каждый ранг получает только свою долю голов).
- `fi_a2a` дополнительно снимает обмен с NCCL и переносит его на фабричную память; на подходящем железе это самый дешевый путь.
- VRAM: `fi_a2a` требует MNNVL-workspace, выделяемого один раз до захвата графов. Путь CUDA graph для `a2a` держит преаллоцированные буферы обмена. У `ag_rs` буфер выхода выделяется в симметричной памяти (`use_symmetric_memory`).
- Время старта: у `fi_a2a` добавляются выделение workspace и обязательный барьер по группе.
- Throughput: косвенно, через межтокенную задержку.

## Взаимодействие с другими аргументами

- `--dcp-size`: обязательная предпосылка; `a2a`/`fi_a2a` требуют значения `> 1`.
- `--dcp-replicate-q-proj`: применим только при `a2a`/`fi_a2a`; убирает еще один коллектив (all-gather Q) на каждый слой.
- `--attention-backend`: определяет основание логарифма LSE (`is_mla_dcp_lse_base_on_e`), под которое настраивается корректирующее ядро; выбор backend'а редукции от этого не зависит, но обе величины участвуют в одном вычислении.
- `--enable-symm-mem`: путь `ag_rs` использует симметричную память для буфера выхода.
- `--tp-size`: определяет, как нарезаются DCP-группы и сколько голов приходится на ранг.

## Типовые проблемы и диагностика

- `ValueError: --dcp-comm-backend a2a only affects the decode context-parallel attention reduction and therefore requires --dcp-size / --decode-context-parallel-size > 1, but got dcp_size=1.`
- `ValueError: --dcp-comm-backend fi_a2a delegates the exchange to FlashInfer's MNNVL All-to-All kernel, … use 'a2a' or 'ag_rs' on clusters without MNNVL.` — отказ на этапе разбора аргументов (не CUDA).
- `RuntimeError: --dcp-comm-backend fi_a2a requires MNNVL fabric memory (e.g. GB200 NVL72); is_mnnvl_fabric_supported() returned False.` — отказ уже на инициализации model runner'а: авторитетная проверка фабрики выполняется там.
- `ImportError: --dcp-comm-backend fi_a2a requires FlashInfer with the DCP all-to-all kernel (flashinfer #2951); …` — установленный FlashInfer слишком старый.
- `AssertionError: num_heads (…) must be divisible by dcp_size (…)` — переключитесь на `ag_rs` или измените `--dcp-size`.
- Значение в дампе `server_args=` не совпадает с заданным — сработал модельный override; ищите строку `Kimi-K3 DCP selects communication backend on '…': '…' -> '…'.`
- Дедлок на первом запросе после старта с `fi_a2a` — обычно означает, что барьер инициализации workspace не прошел на всех рангах; смотрите, у всех ли рангов есть строки инициализации.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --decode-context-parallel-size 4 --dcp-comm-backend a2a
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --decode-context-parallel-size 4 --dcp-comm-backend ag_rs --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/layers/dcp/comm.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/python/sglang/srt/models/deepseek_common/attention_forward_methods/forward_mla.py`
- `sglang/python/sglang/srt/utils/common.py`
