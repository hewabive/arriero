---
schema: 1
engine: vllm
primaryName: "--dbo-decode-token-threshold"
title: "--dbo-decode-token-threshold"
summary: Нижняя граница числа токенов в чисто декодирующем батче, начиная с которой включается разрезание на микробатчи. Значим только вместе с `--enable-dbo` (или `--ubatch-size`) и при `--data-parallel-size > 1`.
group: ParallelConfig
related:
  - --enable-dbo
  - --dbo-prefill-token-threshold
  - --ubatch-size
  - --all2all-backend
  - --data-parallel-size
  - --max-num-seqs
  - --enable-expert-parallel
---

# --dbo-decode-token-threshold

## Кратко

Порог применяется в `check_ubatch_thresholds` к батчам, у которых `uniform_decode` истинно, то есть к шагам, где все запросы декодируют по одному токену. Дефолт `32` примерно означает «микробатчить начиная с 32 одновременно декодирующих последовательностей на ранге».

Ниже порога батч идёт целиком одним куском — разрезание маленького декодирующего батча дороже, чем выигрыш от перекрытия с all2all.

## Оригинальная справка

```text
The threshold for dual batch overlap for batches only containing decodes.
If the number of tokens in the request is greater than this threshold,
microbatching will be used. Otherwise, the request will be processed in a
single batch.
```

## Паспорт аргумента

- Флаги: `--dbo-decode-token-threshold`
- Группа argparse: `ParallelConfig`
- Тип значения: int (токены)
- Допустимые значения: не ограничены списком; валидация `ge=0`
- Значение по умолчанию: `Field(default=32, ge=0)` — то есть `32` при минимуме `0`
- Эффективное значение: не переопределяется; но полностью игнорируется, если `ParallelConfig.use_ubatching` ложно (нет ни `--enable-dbo`, ни `--ubatch-size > 1`) либо если `--data-parallel-size == 1`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.dbo_decode_token_threshold`
- Этап применения: каждый шаг планировщика (решение о микробатчинге) и захват CUDA graph'ов

## Что меняет в движке

```python
def check_ubatch_thresholds(config, num_tokens, uniform_decode):
    if not config.use_ubatching:
        return False
    if uniform_decode:
        return num_tokens >= config.dbo_decode_token_threshold
    return num_tokens >= config.dbo_prefill_token_threshold
```

Две поправки к тексту справки:

- сравнение — **нестрогое** (`>=`), а не «greater than»: батч ровно из `32` токенов при дефолте уже микробатчится;
- `num_tokens` — это число токенов **всего батча ранга** (`num_tokens_unpadded`), а не «в запросе». Для однородного декодирования это фактически число активных последовательностей на ранге.

Результат проверки — лишь заявка. Дальше `_run_ar` собирает согласие всех DP-рангов (элемент `[2]` тензора синхронизации), и микробатчинг включается, только если согласились все и второй микробатч не оказался пустым. Отдельно порог используется на этапе прогрева: ubatched-графы захватываются только для полных CUDA graph'ов на однородных декодирующих батчах, прошедших этот порог.

## Значения и формат

- Целое `≥ 0` в токенах.
- `0` означает «микробатчить любой декодирующий батч» (`num_tokens >= 0` всегда истинно). Отключением DBO это не является — для отключения есть `--no-enable-dbo`.
- Практический верхний ориентир — `--max-num-seqs`: в однородном декодировании больше токенов, чем последовательностей, в батче не будет. Порог выше `--max-num-seqs` фактически выключает микробатчинг на decode-шагах.

## Когда использовать

- Поднимать, если профиль показывает, что на коротких декодирующих шагах разрезание съедает больше, чем даёт перекрытие.
- Понижать, если DP-ранги работают с небольшим числом последовательностей, а доля all2all в шаге всё равно велика.
- Не трогать, если `--enable-dbo` не включён: значение просто не читается.
- Настраивать вместе с `--dbo-prefill-token-threshold`: у prefill- и decode-шагов принципиально разные масштабы числа токенов, потому пороги и разведены.

## Влияние на производительность и память

- **VRAM.** Сам порог памяти не занимает, но влияет на набор захватываемых CUDA graph'ов: чем ниже порог, тем больше декодирующих размеров получают ubatched-версию графа, и тем больше памяти уходит на графы.
- **Latency/throughput.** Единственный смысл флага. Слишком низкий порог добавляет накладные расходы разрезания на шагах, где перекрывать почти нечего; слишком высокий — не даёт DBO включиться в типовом рабочем режиме.
- **Время старта.** Косвенно: больше ubatched-графов — дольше прогрев.

## Взаимодействие с другими аргументами

- `--enable-dbo`: без него (или без `--ubatch-size > 1`) порог не читается.
- `--dbo-prefill-token-threshold`: тот же механизм для батчей с prefill'ами.
- `--data-parallel-size`: при `1` решение о микробатчинге не согласовывается и не принимается.
- `--max-num-seqs`: верхняя граница числа токенов в однородном decode-батче, то есть практический потолок осмысленных значений порога.
- `--all2all-backend`, `--enable-expert-parallel`: определяют, есть ли вообще что перекрывать.

## Типовые проблемы и диагностика

- **Симптом:** DBO включён, но микробатчинг не наблюдается на декодировании. **Причина:** батчи не дотягивают до порога либо в батче меньше двух запросов. **Лечение:** понизить порог или увеличить конкурентность; проверить, что `--data-parallel-size > 1`.
- **Симптом:** в debug-логе повторяется `Aborting ubatching %s %s`. **Причина:** после паддинга второй микробатч оказывается пустым. **Лечение:** поднять порог — на таких размерах разрезание бессмысленно.
- **Симптом:** просадка latency на коротких декодирующих шагах после включения DBO. **Лечение:** поднять этот порог.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `dbo_decode_token_threshold=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --all2all-backend deepep_low_latency --enable-dbo --dbo-decode-token-threshold 64
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --all2all-backend deepep_low_latency --enable-dbo --dbo-decode-token-threshold 16 --max-num-seqs 64
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/worker/ubatch_utils.py`
- `vllm/vllm/v1/worker/dp_utils.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
