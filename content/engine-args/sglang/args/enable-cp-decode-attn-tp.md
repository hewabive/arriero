---
schema: 1
engine: sglang
primaryName: "--enable-cp-decode-attn-tp"
title: "--enable-cp-decode-attn-tp"
summary: Срезает реплицированные линейные слои внимания по CP-рангам на фазе decode, убирая дублирующие GEMM. Работает только для явного списка архитектур DeepSeek-V4 и GLM-5.x DSA.
group: parallel
related:
  - --attn-cp-size
  - --enable-prefill-cp
  - --cp-strategy
  - --tp-size
  - --dp-size
  - --enable-dsa-cache-layer-split
---

# --enable-cp-decode-attn-tp

## Кратко

Под context parallelism на DSA-моделях `attn_tp_size` намеренно удерживается равным 1 — линейные слои внимания реплицированы на всех CP-рангах, потому что коммуникатор не сводит частичные выходы `o_proj` перед реплицированными dense-FFN. На prefill это не проблема (каждый ранг обрабатывает свою часть последовательности), а на decode приводит к тому, что все CP-ранги считают один и тот же GEMM. `--enable-cp-decode-attn-tp` разрезает эти веса по CP-рангам на время decode, превращая CP-разбиение в обычную TP-раскладку. Флаг жестко ограничен списком архитектур: любая другая модель отвергается на старте.

## Оригинальная справка

```text
Enable attention tensor-parallel weight slicing during decode under context parallel (cp_size>1). Slices the replicated attention linears to the local CP partition, eliminating redundant decode GEMMs.
```

## Паспорт аргумента

- Флаги: `--enable-cp-decode-attn-tp`
- Группа: `parallel`
- Тип значения: bool (`store_true`)
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным. Фактическая активация дополнительно требует `attn_cp_size > 1` в runtime: `CpDecodeAttnTpContext.__init__` при `attn_cp_size == 1` печатает `Disable CP decode attention TP` и остается выключенным
- Где объявлен: `ServerArgs.enable_cp_decode_attn_tp`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но с жестким белым списком архитектур
- Этап применения: проверка модели в `_handle_model_specific_adjustments` → создание синглтона `CpDecodeAttnTpContext` в model runner → каждый forward (выбор режима по типу батча)

## Что меняет в движке

### Проверка архитектуры

`_handle_model_specific_adjustments` (`sglang/python/sglang/srt/server_args.py`) сверяет архитектуру модели со списком `CP_DECODE_ATTN_TP_SUPPORTED_ARCHS` (`sglang/python/sglang/srt/layers/cp/cp_decode_attn_tp.py`):

```text
DeepseekV4ForCausalLM, DeepseekV4ForCausalLMNextN, DeepseekV4ForCausalLMDSpark,
GlmMoeDsaForCausalLM, GlmMoeDsaForCausalLMNextN
```

Иначе — отказ на старте:

```text
ValueError: --enable-cp-decode-attn-tp is only supported for models whose attention linears are replicated across CP ranks (attn_tp_size=1). Got <Arch>; supported: [...]
```

Список — единственный источник истины; он не расширяется настройкой.

### Как работает срез

`CpDecodeAttnTpContext` (`sglang/python/sglang/srt/layers/cp/cp_decode_attn_tp.py`) при включенном флаге и `attn_cp_size > 1` запоминает `decode_tp_rank = attn_cp_rank`, `decode_tp_size = attn_cp_size` и печатает `Enable CP decode attention TP`. Дальше на каждом forward'е `set_decode_attn_tp(forward_batch)` решает, применять ли срез: он **выключается** на шагах, где активен CP-v2 (`is_cp_v2_active`) или идет prefill-CP DSA (`dsa_use_prefill_cp`), потому что там нужны все головы, и **включается** на всех остальных, в том числе на decode. Срезы кешируются (`_slice_cache`), чтобы не резать веса заново каждый шаг.

По сути CP-группа на время decode начинает играть роль attention-TP-группы: каждый ранг считает свою долю голов вместо полной копии.

## Значения и формат

- Булев флаг без значения; «выключено» = не указывать.
- Практическое условие включения — `attn_cp_size > 1`. Флаг без CP примут, проверка архитектуры выполнится, но эффекта не будет.
- Отключающего флага нет; отмена — убрать аргумент.

## Когда использовать

- DeepSeek-V4 или GLM-5.x DSA с включенным prefill-CP, где заметная доля времени уходит на decode: срез убирает дублирующие GEMM ровно там, где они не нужны.
- Смешанная нагрузка «длинный промпт + длинный ответ»: prefill выигрывает от CP, decode — от этого флага; по отдельности каждая фаза остается неоптимальной.
- Не включать на моделях вне списка: запуск просто не состоится.
- Не включать без CP: `attn_cp_size == 1` делает флаг бездействующим.
- Не рассматривать как способ уменьшить VRAM: срез применяется к вычислению, веса при этом уже загружены целиком на каждом ранге.

## Влияние на производительность и память

- Decode-latency и decode-throughput: основной эффект. Объем GEMM линейных слоев внимания на ранг делится на `attn_cp_size`.
- Prefill: не затрагивается — на CP-шагах срез выключается.
- VRAM: заметного изменения нет. Веса остаются реплицированными (они уже загружены), экономится вычисление, а не память; добавляется небольшой кеш срезов.
- Коммуникация: дополнительных коллективов не появляется — разбиение идет по уже существующей CP-группе.

## Взаимодействие с другими аргументами

- `--attn-cp-size`: источник и ранга, и размера «decode-TP»; при значении `1` флаг бездействует.
- `--enable-prefill-cp` / `--cp-strategy`: практическая предпосылка — без них CP-группа не наполнена смыслом, а срез выключается на CP-шагах.
- `--enable-dsa-cache-layer-split`: соседняя оптимизация того же семейства, но про память DSA-кеша, а не про GEMM decode; они независимы.
- `--tp-size` / `--dp-size`: определяют, каким получится `attn_cp_size` и, следовательно, глубина среза.

## Типовые проблемы и диагностика

- `ValueError: --enable-cp-decode-attn-tp is only supported for models whose attention linears are replicated across CP ranks (attn_tp_size=1). Got …; supported: [...]` — модель не входит в белый список.
- Флаг задан, ускорения нет — проверьте строку `Enable CP decode attention TP` в логе. Если вместо нее `Disable CP decode attention TP`, значит `attn_cp_size == 1`.
- Эффект виден только на длинных ответах — ожидаемо: срез применяется на decode-шагах, а не на prefill.
- Что смотреть в логе: `enable_cp_decode_attn_tp=` и `attn_cp_size=` в дампе `server_args=`, `Enable CP decode attention TP` / `Disable CP decode attention TP` при инициализации model runner'а.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tensor-parallel-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave --enable-cp-decode-attn-tp
```

```bash
python -m sglang.launch_server --model-path /models/GLM-5-DSA --tensor-parallel-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag --attention-context-parallel-size 8 --enable-cp-decode-attn-tp
```

## Источники

- `sglang/python/sglang/srt/layers/cp/cp_decode_attn_tp.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/cp/utils.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
