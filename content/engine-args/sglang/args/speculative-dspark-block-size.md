---
schema: 1
engine: sglang
primaryName: "--speculative-dspark-block-size"
title: "--speculative-dspark-block-size"
summary: Гамма DSPARK — сколько draft-токенов предлагается за раунд. Окно верификации на единицу больше, поэтому аргумент задаёт `--speculative-num-draft-tokens = gamma + 1`. Читается только хуком DSPARK; не задан — гамма берётся из конфига draft-чекпоинта, иначе 7.
group: spec
related:
  - --speculative-algorithm
  - --speculative-num-draft-tokens
  - --speculative-draft-model-path
  - --speculative-dspark-sps-table-path
  - --speculative-dspark-confidence-sts-path
  - --speculative-dspark-align-verify-tokens-to-graph-tier
  - --speculative-num-steps
  - --speculative-eagle-topk
---

# --speculative-dspark-block-size

## Кратко

DSPARK предлагает блок из `gamma` токенов и верифицирует окно `gamma + 1` (лишняя позиция — якорь/бонусный токен). Этот аргумент задаёт именно `gamma`, а не ширину окна: перепутать легко, потому что общее поле `--speculative-num-draft-tokens` хранит как раз ширину окна. Значение обязано соответствовать чекпоинту: draft обучен на своём `block_size`, и расхождение движок либо отвергает, либо сопровождает предупреждением.

## Оригинальная справка

```text
DSPARK only. Draft block size gamma (number of proposed draft tokens). The verify window is gamma + 1, so this sets --speculative-num-draft-tokens = gamma + 1. Omit to auto-infer gamma from the draft checkpoint block_size.
```

## Паспорт аргумента

- Флаги: `--speculative-dspark-block-size`
- Группа: `spec`
- Тип значения: целое (`Optional[int]`), число предлагаемых токенов
- Допустимые значения: строго положительное; итоговое `num_draft_tokens = gamma + 1` обязано быть `>= 2`
- Значение по умолчанию: `null`
- Эффективное значение: при заданном значении `speculative_num_draft_tokens = gamma + 1`. При незаданном гамма читается из конфига draft-чекпоинта (`read_draft_checkpoint_gamma`); если конфиг не прочитался и `--speculative-num-draft-tokens` тоже не задан, берётся `DEFAULT_DSPARK_GAMMA = 7` с предупреждением. Здесь же `speculative_num_steps` и `speculative_eagle_topk` принудительно становятся `1`
- Где объявлен: `ServerArgs.speculative_dspark_block_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, алгоритмо-специфичный: читатели — `_handle_dspark` и модельный override Kimi-K3
- Этап применения: `__post_init__` (модельный override Kimi-K3 → `_handle_dspark`) → ширина verify-форварда и резерв KV → захват CUDA graph → forward

## Что меняет в движке

В `_handle_dspark`:

1. неположительное значение — `ValueError`;
2. иначе `gamma` = заданное значение, а если не задано — `read_draft_checkpoint_gamma(...)` по hf-конфигу draft'а (ключ `dspark_block_size` / `block_size`); при исключении печатается предупреждение и, если `--speculative-num-draft-tokens` тоже пуст, подставляется 7;
3. `verify_window = gamma + 1`; если `--speculative-num-draft-tokens` задан и не равен окну — `ValueError` с обоими числами;
4. итог записывается в `speculative_num_draft_tokens`; значение меньше 2 отвергается.

Позже, уже при инициализации воркера, `resolve_runtime_config` повторяет сверку с чекпоинтом и при расхождении печатает `DSpark gamma mismatch: using gamma=X (from speculative_num_draft_tokens=Y) but draft config block_size=Z`. Оттуда же берутся `mask_token_id` и требование `markov_rank > 0`.

Отдельная тонкость: модельный override Kimi-K3 на SM100/SM103 читает это поле **до** автовывода из чекпоинта, чтобы прикинуть `q_len` verify-форварда и решить, можно ли отправить verify на decode-backend. Если значение не задано, он подставляет 8 (то есть gamma 7) как эвристику для K3-драфта.

`gamma` определяет и все производные размеры: ширину verify (`num_draft_tokens`, для draft-воркера — `num_draft_tokens − 1`), резерв KV на шаг, длину таблиц калибровки (STS-таблица обязана быть на ровно `gamma` позиций) и бюджет ragged-verify планировщика.

## Значения и формат

- Целое число предлагаемых токенов. Типичное значение для существующих DSPARK-чекпоинтов — 7 (окно 8).
- `0` и отрицательные — `ValueError: DSpark requires --speculative-dspark-block-size to be positive`.
- Не задавать — правильный режим по умолчанию: чекпоинт сам скажет, на какую гамму он обучен.
- Задавать `--speculative-num-draft-tokens` вместо этого флага можно, но тогда оно обязано быть ровно `gamma + 1`, иначе старт падает.
- При любом алгоритме, кроме `DSPARK`, значение не читается (кроме упомянутой эвристики Kimi-K3, которая тоже срабатывает только при `--speculative-algorithm DSPARK`).

## Когда использовать

- В конфиге draft-чекпоинта нет `block_size`, и вы не хотите молча получить 7.
- Нужно сузить блок под большой running batch: verify стоит `gamma + 1` токенов на запрос за раунд.
- Не увеличивать сверх обученной гаммы: draft-голова и Markov-часть обучены на конкретную длину блока, а STS-калибровка вообще перестанет подходить по размеру и вызовет ошибку.
- Не пытаться выключить спекуляцию значением 1: `gamma = 1` допустим (окно 2), но это уже вырожденный режим — дешевле не включать DSPARK.

## Влияние на производительность и память

- VRAM: линейно по `gamma + 1` — резерв KV на запрос на шаг, ширина verify-буферов, размер захваченных verify-графов.
- Latency: верхняя граница выигрыша за раунд — `gamma` токенов сверх одного; фактическая величина видна как `accept len`.
- Throughput: при большом батче широкое окно дорого, потому что verify оплачивает все `gamma + 1` позиций независимо от того, сколько будет принято. Именно эту неэффективность адресуют ragged-verify режимы (`SGLANG_RAGGED_VERIFY_MODE`) и `--speculative-dspark-align-verify-tokens-to-graph-tier`.
- Время старта: больше блок — дольше захват графов.

## Взаимодействие с другими аргументами

- `--speculative-num-draft-tokens`: то же самое, но на единицу больше; расхождение — ошибка.
- `--speculative-algorithm DSPARK`: единственный режим, где значение действует.
- `--speculative-draft-model-path`: источник значения по умолчанию.
- `--speculative-dspark-confidence-sts-path`: калибровочная таблица должна быть на ровно `gamma` позиций, иначе `ValueError` с обеими величинами.
- `--speculative-dspark-sps-table-path` и `--speculative-dspark-align-verify-tokens-to-graph-tier`: работают поверх этого же окна.
- `--speculative-num-steps` / `--speculative-eagle-topk`: принудительно `1`.
- `--enable-dp-attention` / `--enable-dp-lm-head` / `--moe-a2a-backend`: у DSPARK с DP-вниманием свои требования, проверяемые тем же хуком.

## Типовые проблемы и диагностика

- `DSpark requires --speculative-dspark-block-size to be positive, got 0`.
- `DSpark speculative_num_draft_tokens must equal gamma + 1 (= 8 for gamma=7), but got speculative_num_draft_tokens=7` — заданы оба флага несогласованно.
- `DSpark speculative_num_draft_tokens must be >= 2 (= gamma + 1), got 1`.
- `DSpark gamma is not set; defaulting to 7.` — конфиг чекпоинта не дал значение.
- `Failed to read DSpark gamma from draft model config; cannot cross-check --speculative-num-draft-tokens. Error: …` — конфиг draft'а не прочитался.
- `DSpark gamma mismatch: using gamma=X … but draft config block_size=Y.` — ваше значение победило, но чекпоинт обучен под другое; ожидайте падения accept rate.
- Что смотреть: поля `speculative_dspark_block_size` и `speculative_num_draft_tokens` в дампе `server_args=`, `accept len` в строках `Decode batch`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --speculative-algorithm DSPARK --speculative-draft-model-path /models/DeepSeek-V3.2-DSpark-Draft --speculative-dspark-block-size 7
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --speculative-algorithm DSPARK --speculative-draft-model-path /models/DeepSeek-V3.2-DSpark-Draft --speculative-dspark-block-size 3 --max-running-requests 32 --mem-fraction-static 0.82
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_config.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_worker_v2.py`
- `sglang/python/sglang/srt/mem_cache/allocation_sizing.py`
- `sglang/python/sglang/srt/speculative/spec_info.py`
