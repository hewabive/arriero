---
schema: 1
engine: sglang
primaryName: "--speculative-skip-dp-mlp-sync"
title: "--speculative-skip-dp-mlp-sync"
summary: Убирает дополнительную коллективную синхронизацию, которую планировщик делает перед слиянием нового prefill-батча при связке спекуляции и DP attention. Разрешён только для `--speculative-algorithm EAGLE`.
group: spec
related:
  - --speculative-algorithm
  - --enable-dp-attention
  - --dp-size
  - --enable-dp-lm-head
  - --disable-overlap-schedule
  - --speculative-dspark-sps-table-path
---

# --speculative-skip-dp-mlp-sync

## Кратко

Когда включены и спекулятивное декодирование, и DP attention, планировщик SGLang делает **две** MLP-синхронизации за итерацию: одну перед слиянием нового prefill-батча в running-батч и одну в конце. Первая нужна, чтобы prefill и decode не смешались в одном шаге на разных DP-рангах. `--speculative-skip-dp-mlp-sync` убирает её. Это микрооптимизация планировщика, а не ручка производительности модели: на инстансе без DP attention она не делает ничего, но всё равно требует `--speculative-algorithm EAGLE`.

## Оригинальная справка

```text
Skip the extra MLP sync that the scheduler performs before merging a new batch when speculative decoding + DP attention are both enabled.
```

## Паспорт аргумента

- Флаги: `--speculative-skip-dp-mlp-sync`
- Группа: `spec`
- Тип значения: bool. Обычное поле `bool` → `add_cli_args_from_dataclass` регистрирует `action="store_true"`: флаг без значения, парного `--no-…` нет
- Допустимые значения: наличие флага
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; несовместимая связка отвергается `assert` на старте
- Где объявлен: `ServerArgs.speculative_skip_dp_mlp_sync`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `handle_speculative_decoding` (проверка) → каждая итерация планировщика (`Scheduler.get_next_batch_to_run`) → инициализация DSPARK-планировщика

## Что меняет в движке

В `Scheduler.get_next_batch_to_run` (`sglang/python/sglang/srt/managers/scheduler.py`) стоит ветка:

```python
need_mlp_sync = self.require_mlp_sync
if need_mlp_sync and not self.spec_algorithm.is_none() and not get_spec().speculative_skip_dp_mlp_sync:
    new_batch = self.dp_attn_adapter.maybe_prepare_mlp_sync_batch(new_batch)
    need_mlp_sync = new_batch is None
```

Комментарий в коде прямо говорит назначение этой ветки: она гарантирует, что prefill- и decode-батчи не смешаются, когда включены спекуляция и DP attention. Флаг её выключает — остаётся только финальная `maybe_prepare_mlp_sync_batch(ret, need_sync=need_mlp_sync)` в конце функции. Экономится одна коллективная операция на итерацию планировщика (она включает обмен между DP-рангами и потому стоит round-trip).

`require_mlp_sync` истинно только при активном DP attention / gather-режиме. Если DP attention выключен, ветка и так не выполняется, и флаг ничего не меняет.

Второе место — DSPARK: в `sglang/python/sglang/srt/speculative/dspark_components/dspark_planner.py` `_dp_tier_gather_enabled` требует `not get_spec().speculative_skip_dp_mlp_sync`. То есть при включённом флаге компактный ragged-verify отказывается от DP-tier gather и выбирает pinned-тир графов. На практике до этого не доходит: `handle_speculative_decoding` разрешает флаг только для EAGLE.

Проверка на старте (`sglang/python/sglang/srt/arg_groups/speculative_hook.py`):

```python
if server_args.speculative_skip_dp_mlp_sync:
    assert server_args.speculative_algorithm == "EAGLE", ...
```

Сравнение строгое и выполняется **после** раскрытия псевдонимов: `NEXTN` к этому моменту уже стал `EAGLE` и проходит, а `EAGLE3`, `STANDALONE`, `NGRAM`, `DFLASH`, `DSPARK`, `FROZEN_KV_MTP` — нет.

## Значения и формат

- Флаг без значения: `--speculative-skip-dp-mlp-sync`. Значение после флага argparse не примет.
- Отсутствие флага — синхронизация выполняется (поведение по умолчанию и единственное проверенное апстримом на всех алгоритмах).
- Никаких промежуточных режимов нет.

## Когда использовать

- На многоранговой конфигурации с `--enable-dp-attention` и `--speculative-algorithm EAGLE`, когда профиль показывает, что заметная доля времени итерации уходит в коллективы планировщика, а не в forward. Обычно это конфигурации с большим `--dp-size` и короткими decode-шагами.
- Не включать «просто так» на одиночной карте: без DP attention эффекта нет, а совместимость с алгоритмом флаг всё равно ограничивает.
- Не включать при EAGLE3 — старт упадёт на `assert`.
- Не рассматривать как средство борьбы с OOM или с низкой acceptance rate: к памяти и к качеству черновика флаг отношения не имеет.

## Влияние на производительность и память

- На память не влияет: аргумент только убирает одну коллективную операцию из расписания планировщика.
- Throughput/latency: выигрыш — одна межранговая синхронизация на итерацию планировщика; заметен только там, где такая синхронизация — существенная доля шага (большой `--dp-size`, малое число токенов на шаг).
- Риск: пропадает гарантия, ради которой ветка написана — что новый prefill-батч не будет слит с decode-батчем без общей синхронизации рангов. Это поведенческое изменение планировщика при `--enable-dp-attention`, поэтому включать его стоит только с измерением до/после и с проверкой корректности ответов под конкурентной нагрузкой.
- На время старта не влияет.

## Взаимодействие с другими аргументами

- `--speculative-algorithm`: разрешён строго `EAGLE` (в том числе через псевдоним `NEXTN`).
- `--enable-dp-attention` / `--dp-size`: без них флаг инертен, потому что `require_mlp_sync` ложно.
- `--enable-dp-lm-head`: часть той же DP-конфигурации; на сам флаг не влияет.
- `--disable-overlap-schedule`: другой слой расписания; независим, но оба меняют, как выглядит итерация планировщика — меняйте их по одному.
- `--speculative-dspark-sps-table-path`: флаг участвует в условии `_dp_tier_gather_enabled` DSPARK-планировщика, но комбинация недостижима из-за проверки алгоритма.

## Типовые проблемы и диагностика

- `AssertionError: --speculative-skip-dp-mlp-sync is only supported with speculative_algorithm == EAGLE, got EAGLE3` (или другой алгоритм) — единственная явная ошибка этого аргумента.
- Флаг задан, но профиль не изменился — скорее всего DP attention не включён и ветка не выполнялась. Проверьте `enable_dp_attention` и `dp_size` в дампе `server_args=`.
- Нестабильное поведение под смешанной нагрузкой (одновременные длинные prefill и decode) на многоранговой конфигурации после включения — верните флаг в значение по умолчанию и сравните.
- Чем подтвердить, что значение принято: дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`), поле `speculative_skip_dp_mlp_sync`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --speculative-algorithm EAGLE --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --tp-size 8 --dp-size 8 --enable-dp-attention --speculative-skip-dp-mlp-sync
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --speculative-algorithm NEXTN --speculative-num-steps 2 --speculative-eagle-topk 1 --speculative-num-draft-tokens 3 --tp-size 4 --dp-size 4 --enable-dp-attention --enable-dp-lm-head --speculative-skip-dp-mlp-sync
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_planner.py`
