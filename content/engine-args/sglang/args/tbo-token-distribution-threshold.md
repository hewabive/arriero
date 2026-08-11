---
schema: 1
engine: sglang
primaryName: "--tbo-token-distribution-threshold"
title: "--tbo-token-distribution-threshold"
summary: Порог перекоса токенов между микробатчами two-batch overlap. Если разрез по границе последовательностей дает более неравные половины, чем допускает порог, движок разрубает одну последовательность на два микробатча. `0` запрещает такой разрез.
group: exec.overlap
related:
  - --enable-two-batch-overlap
  - --enable-single-batch-overlap
  - --chunked-prefill-size
  - --max-prefill-tokens
  - --enable-dp-attention
  - --moe-a2a-backend
---

# --tbo-token-distribution-threshold

## Кратко

Two-batch overlap выигрывает ровно тогда, когда микробатчи примерно равны: работа одного должна прикрывать коммуникацию другого. На prefill-фазе с длинными разнородными последовательностями честный разрез по границе запросов часто дает сильный перекос — например, один запрос на 8000 токенов и три по 200. `--tbo-token-distribution-threshold` задает, при каком перекосе движок переходит к «двухчанковому» разрезу: рубит одну последовательность посередине суммарного числа токенов, отдавая ее хвост второму микробатчу.

Значение 0.48 по умолчанию означает: если левая половина после разреза по границам последовательностей содержит меньше 48 % или больше 52 % токенов, включается двухчанковый разрез. Значение `0` его полностью запрещает.

## Оригинальная справка

```text
The threshold of token distribution between two batches in micro-batch-overlap, determines whether to two-batch-overlap or two-chunk-overlap. Set to 0 denote disable two-chunk-overlap.
```

## Паспорт аргумента

- Флаги: `--tbo-token-distribution-threshold`
- Группа: `exec.overlap`
- Тип значения: float (доля токенов)
- Допустимые значения: `0` … `0.5` включительно. Значение больше `0.5` роняет батч ассертом `assert threshold <= 0.5`
- Значение по умолчанию: `0.48`
- Эффективное значение: совпадает с заданным. Если глобальная MoE-конфигурация почему-то не была инициализирована, геттер подставляет `0.48` с warning'ом `TBO_TOKEN_DISTRIBUTION_THRESHOLD is not initialized, using 0.48`
- Где объявлен: `ServerArgs.tbo_token_distribution_threshold`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация MoE-конфигурации (`initialize_moe_config`) → подготовка каждого extend/mixed-батча при включенном TBO

## Что меняет в движке

Решение принимает `_is_two_chunk_split_enabled` (`sglang/python/sglang/srt/batch_overlap/two_batch_overlap.py`):

```python
vanilla_split = _split_array_by_balanced_sum(extend_lens)   # разрез по границе последовательностей
left_sum = sum(extend_lens[:vanilla_split])
threshold = get_tbo_token_distribution_threshold()
want_two_chunk = left_sum < overall_sum * threshold or left_sum > overall_sum * (1 - threshold)
```

Если перекос допустим, используется разрез по границам (`_split_array_by_balanced_sum` — индекс с минимальной разницей сумм). Если нет, применяется `_split_array_by_cum_less_than_half`: индекс первой последовательности, на которой накопленная сумма превысила половину, — то есть эта последовательность разрубается между микробатчами.

Есть защитная оговорка: при двухчанковом разрезе первый микробатч охватывает последовательности `[0 .. split_index]`, но получает ровно `overall_sum // 2` query-токенов. На вырожденном батче (одна последовательность или почти пустой DP-sync-батч) это дает больше последовательностей, чем токенов, что нарушает инвариант планировщика DSV4-compress. В таком случае движок возвращается к разрезу по границам независимо от порога.

Аргумент влияет только на extend- и mixed-режимы: в decode и target-verify батч всегда делится пополам по числу последовательностей, а в idle/prebuilt делить нечего.

## Значения и формат

- Дробное число от 0 до 0.5. Смысл — доля токенов в меньшей половине, ниже которой перекос считается недопустимым.
- `0` отключает двухчанковый разрез: условие `left_sum < 0` ложно, а `left_sum > overall_sum` невозможно.
- `0.5` требует идеального деления пополам, то есть почти всегда включает двухчанковый разрез.
- Значение больше `0.5` не отвергается на старте, но роняет первый же extend-батч ассертом.
- Без `--enable-two-batch-overlap` значение не читается.

## Когда использовать

- Понижать (0.3–0.4), если двухчанковый разрез в вашей нагрузке вредит: он рубит последовательность и потому делает работу микробатчей менее однородной по метаданным внимания, хотя и выравнивает число токенов.
- Ставить `0`, когда нагрузка состоит из множества коротких запросов: разрез по границам там и так почти идеален, а разрубание последовательности — лишний риск.
- Оставлять по умолчанию на смешанной нагрузке с длинными промптами: именно для нее порог и подобран.
- Не поднимать выше 0.5 — ассерт сработает не на старте, а на первом батче под нагрузкой.

## Влияние на производительность и память

- VRAM: не влияет — разрез не меняет суммарный объем активаций, только их распределение между микробатчами.
- RAM хоста: не влияет.
- Время старта: не влияет.
- Throughput на prefill: главный эффект. Равные микробатчи означают, что коммуникация одного полностью прикрыта вычислением другого; при сильном перекосе TBO вырождается в последовательное исполнение с накладными расходами.
- Latency: следует за throughput на длинных промптах; на decode аргумент не действует.

## Взаимодействие с другими аргументами

- `--enable-two-batch-overlap`: единственный флаг, при котором значение читается.
- `--chunked-prefill-size` / `--max-prefill-tokens`: определяют, какие наборы длин вообще попадают в один батч, а значит и насколько часто срабатывает порог.
- `--enable-single-batch-overlap`: независимый механизм, порога не касается.
- `--enable-dp-attention` / `--moe-a2a-backend`: определяют, применяется ли TBO к конкретному батчу вообще (согласование forward mode между DP-рангами, ограничение low-latency DeepEP на extend).

## Типовые проблемы и диагностика

- `AssertionError: threshold=0.6` на первом длинном запросе — значение больше 0.5.
- `TBO_TOKEN_DISTRIBUTION_THRESHOLD is not initialized, using 0.48` — MoE-конфигурация не была инициализирована до первого обращения; значение из CLI в этом случае не применилось.
- Двухчанковый разрез не срабатывает, хотя перекос очевиден — сработала защита от вырожденного батча (`child_a_batch_size > child_a_num_q_tokens`), либо в батче одна последовательность.
- TBO включен, а выигрыша на prefill нет — сравните распределение длин в батче с порогом; при однородной нагрузке аргумент вообще не активен.
- Что смотреть: `tbo_token_distribution_threshold=` в дампе `server_args=`; отдельной строки о выбранном типе разреза движок не печатает — судить приходится по профилю.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --enable-two-batch-overlap --moe-a2a-backend deepep --tbo-token-distribution-threshold 0.4
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --enable-two-batch-overlap --moe-a2a-backend deepep --tbo-token-distribution-threshold 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/batch_overlap/two_batch_overlap.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
