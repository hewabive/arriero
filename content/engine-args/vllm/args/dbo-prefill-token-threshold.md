---
schema: 1
engine: vllm
primaryName: "--dbo-prefill-token-threshold"
title: "--dbo-prefill-token-threshold"
summary: Нижняя граница числа токенов в батче с хотя бы одним prefill'ом, начиная с которой включается разрезание на микробатчи. Значим только вместе с `--enable-dbo` (или `--ubatch-size`) и при `--data-parallel-size > 1`.
group: ParallelConfig
related:
  - --enable-dbo
  - --dbo-decode-token-threshold
  - --ubatch-size
  - --all2all-backend
  - --data-parallel-size
  - --max-num-batched-tokens
  - --long-prefill-token-threshold
  - --enable-chunked-prefill
  - --enable-expert-parallel
---

# --dbo-prefill-token-threshold

## Кратко

Второй из двух порогов DBO: он применяется, когда в батче есть хотя бы один prefill, то есть `uniform_decode` ложно. Дефолт `512` заметно выше decode-порога, потому что prefill-батчи считаются тысячами токенов, и разрезать имеет смысл только достаточно большой.

В исходнике `vllm/config/parallel.py` рядом с дефолтом стоит пометка автора о том, что значение ещё не подбиралось экспериментально, — так что это разумная отправная точка, а не оттюненный оптимум.

## Оригинальная справка

```text
The threshold for dual batch overlap for batches that contain one or more
prefills. If the number of tokens in the request is greater than this
threshold, microbatching will be used. Otherwise, the request will be
processed in a single batch.
```

## Паспорт аргумента

- Флаги: `--dbo-prefill-token-threshold`
- Группа argparse: `ParallelConfig`
- Тип значения: int (токены)
- Допустимые значения: не ограничены списком; валидация `ge=0`
- Значение по умолчанию: `Field(default=512, ge=0)` — то есть `512` при минимуме `0`
- Эффективное значение: не переопределяется; полностью игнорируется, если `ParallelConfig.use_ubatching` ложно (нет ни `--enable-dbo`, ни `--ubatch-size > 1`) либо если `--data-parallel-size == 1`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.dbo_prefill_token_threshold`
- Этап применения: каждый шаг планировщика — решение о микробатчинге

## Что меняет в движке

`check_ubatch_thresholds(config, num_tokens, uniform_decode)` при `uniform_decode == False` возвращает `num_tokens >= config.dbo_prefill_token_threshold`. Две поправки к справке:

- сравнение **нестрогое** (`>=`), а не «greater than»;
- `num_tokens` — это `num_tokens_unpadded`, то есть суммарное число запланированных токенов батча на этом ранге, а не длина отдельного запроса. При chunked prefill это размер очередного куска, а не полная длина промпта.

Дальше решение проходит через тот же коллектив согласования DP-рангов, что и decode-порог, и отменяется, если второй микробатч выходит пустым (`is_last_ubatch_empty`). В отличие от decode-порога, prefill-порог не участвует в захвате CUDA graph'ов: ubatched-графы захватываются только для однородных декодирующих батчей.

## Значения и формат

- Целое `≥ 0` в токенах.
- `0` означает «микробатчить любой батч с prefill'ом»; отключением DBO это не является.
- Практический потолок — `--max-num-batched-tokens`: батч на ранге не превысит эту величину, поэтому порог выше неё фактически отключает микробатчинг на prefill-шагах.
- Осмысленный диапазон настройки — от нескольких сотен до нескольких тысяч токенов, в зависимости от того, при каком размере prefill'а на вашем железе all2all перестаёт быть пренебрежимым.

## Когда использовать

- Понижать, если типовой prefill-батч меньше 512 токенов (короткие промпты, маленький `--max-num-batched-tokens`), а перекрытие с all2all всё же хочется получить.
- Повышать, если на средних prefill'ах разрезание даёт просадку: prefill и так хорошо загружает GPU, и перекрывать там часто нечего.
- Не трогать без `--enable-dbo`.
- Не выравнивать с `--dbo-decode-token-threshold`: пороги разведены намеренно, у prefill- и decode-батчей разный масштаб.

## Влияние на производительность и память

- **VRAM.** Прямого влияния нет: prefill-микробатчи не порождают дополнительных захваченных графов.
- **TTFT.** Основной наблюдаемый эффект. Разрезание длинного prefill'а перекрывает счёт с обменом, но добавляет накладные расходы на само разделение и на дополнительную синхронизацию.
- **Throughput.** Зависит от доли all2all в prefill-шаге; на развертывании без EP выигрыша нет по построению.

## Взаимодействие с другими аргументами

- `--enable-dbo`: без него (или без `--ubatch-size > 1`) порог не читается.
- `--dbo-decode-token-threshold`: тот же механизм для чисто декодирующих батчей.
- `--data-parallel-size`: при `1` решение о микробатчинге не принимается.
- `--max-num-batched-tokens`: верхняя граница числа токенов в батче, то есть практический потолок значений порога.
- `--enable-chunked-prefill`, `--long-prefill-token-threshold`: определяют, какими кусками prefill попадает в батч, а значит и попадёт ли батч за порог.
- `--all2all-backend`, `--enable-expert-parallel`: определяют, есть ли что перекрывать.

## Типовые проблемы и диагностика

- **Симптом:** DBO включён, decode микробатчится, а prefill — нет. **Причина:** prefill-батчи меньше 512 токенов. **Лечение:** понизить порог либо увеличить `--max-num-batched-tokens`.
- **Симптом:** после включения DBO вырос TTFT. **Причина:** разрезание prefill'ов, на которых перекрывать нечего. **Лечение:** поднять порог.
- **Симптом:** в debug-логе `Aborting ubatching %s %s` на prefill-шагах. **Причина:** после паддинга второй микробатч пустой. **Лечение:** поднять порог.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `dbo_prefill_token_threshold=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --all2all-backend deepep_high_throughput --enable-dbo --dbo-prefill-token-threshold 1024
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --all2all-backend deepep_high_throughput --enable-dbo --dbo-prefill-token-threshold 256 --max-num-batched-tokens 4096
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/worker/ubatch_utils.py`
- `vllm/vllm/v1/worker/dp_utils.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
