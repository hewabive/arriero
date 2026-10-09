---
schema: 1
engine: vllm
primaryName: "--swa-bounded-replay"
title: "--swa-bounded-replay"
summary: Для DeepSeek-V4.1 исключает sliding-window KV из prefix caching и после попадания в префикс пересчитывает последнее окно вместо того, чтобы хранить SWA-блоки в кэше. Включен по умолчанию; фактически работает только на model runner V2, на NVIDIA и без prefill context parallel.
group: CacheConfig
related:
  - --enable-prefix-caching
  - --prefix-cache-retention-interval
  - --prefill-context-parallel-size
  - --kv-transfer-config
  - --max-num-batched-tokens
  - --long-prefill-token-threshold
---

# --swa-bounded-replay

## Кратко

У DeepSeek-V4.1 KV-cache состоит из нескольких групп: сжатый KV, который участвует в prefix caching, и sliding-window (SWA) KV. Чтобы попадание в префикс было полным, SWA-группе нужен KV последнего окна перед границей попадания, а хранить его для всех возможных границ дорого. Bounded replay решает это иначе: SWA-группа в prefix caching не участвует, а после попадания движок пересчитывает последние `sliding_window` токенов, восстанавливая SWA KV, и не трогает уже закэшированный KV остальных групп.

Флаг касается только моделей, которые это поддерживают; в этом commit'е это реализация `vllm/models/deepseek_v41/`. На остальных моделях он ничего не меняет.

## Оригинальная справка

```text
Keep the sliding-window KV of models that support it (DeepSeek-V4.1)
out of prefix caching and rebuild it after a prefix hit by recomputing the
hit's last window. Requires model runner V2.
```

## Паспорт аргумента

- Флаги: `--swa-bounded-replay`, `--no-swa-bounded-replay`
- Группа argparse: `CacheConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-swa-bounded-replay` ⇒ `False`
- Значение по умолчанию: `True`
- Эффективное значение: слой внимания DeepSeek-V4.1 (`vllm/models/deepseek_v41/attention.py`) молча сбрасывает его в `False` с предупреждением в логе, если движок работает на model runner V1, если `prefill_context_parallel_size > 1` или на ROCm. В этих случаях SWA-группа участвует в prefix caching обычным образом
- Где объявлен: `vllm/config/cache.py:CacheConfig.swa_bounded_replay`
- Этап применения: построение модели (решение слоя внимания) → `get_kv_cache_spec` (`SlidingWindowMLASpec.bounded_replay`) → инициализация планировщика (`prefix_replay_tokens`) → впуск каждого запроса с попаданием в префикс → forward (model state V2)

## Что меняет в движке

**Спецификация KV-cache.** SWA-кэш DeepSeek-V4.1 объявляет `SlidingWindowMLASpec(bounded_replay=True)`. У такой спецификации `prefix_cacheable == False` и `prefix_replay_tokens == sliding_window`. Следствия:

- SWA-блоки не кэшируются (`cache_blocks` для группы возвращается сразу) и не участвуют в поиске префикса; длину попадания определяют остальные группы;
- размер hash-блока выбирается только по prefix-cacheable группам.

**Планировщик.** `Scheduler.prefix_replay_tokens` берется из спецификаций групп (все replay-окна обязаны совпадать). При впуске запроса из waiting-очереди:

- попадание длиной `<= sliding_window` отбрасывается целиком: пересчет окна стоил бы столько же, сколько само попадание;
- при более длинном попадании `_mark_prefix_replay` записывает `request.replay_start = hit - window` и уменьшает число вычисленных токенов на `window`; эти токены снова планируются в prefill;
- внешнее попадание от KV-коннектора округляется вниз до границы блока; асинхронная загрузка выполняет replay после прихода KV.

**Worker.** `DeepseekV41ModelState` передает `replay_start` метаданным SWA-внимания, а слоты пересчитываемых токенов в prefix-cacheable группах заменяет пустыми (`PAD_SLOT_ID`), чтобы закэшированный KV не перезаписывался. Ядра SWA-prefill не читают окно ниже `replay_start`. Именно поэтому нужен model runner V2: только он пропускает запись paged-KV для пересчитываемых токенов.

Поле исключено из хеша `CacheConfig.compute_hash`: переключение не инвалидирует кэш компиляции.

## Значения и формат

- Булев флаг. По умолчанию включен, выключение — `--no-swa-bounded-replay`.
- Числовых параметров нет: длина пересчета всегда равна `sliding_window` из конфига модели.
- На моделях без поддержки и при выключенном prefix caching значение ни на что не влияет.

## Когда использовать

- Оставляйте включенным для DeepSeek-V4.1 с prefix caching на NVIDIA: попадание не зависит от того, сохранились ли SWA-блоки нужной границы, а цена — пересчет одного окна на каждое попадание.
- `--no-swa-bounded-replay` имеет смысл для сравнения или при подозрении на ошибку в пути replay: SWA-группа тогда снова кэшируется, и где именно возможны попадания, определяет `--prefix-cache-retention-interval`.
- Не ищите в этом флаге способ уменьшить пересчет на коротких общих префиксах: попадание короче окна не используется вовсе.

## Влияние на производительность и память

- **Prefill после попадания.** Добавляется пересчет `sliding_window` токенов на каждый запрос с попаданием; на длинных общих префиксах это малая доля от сэкономленного.
- **TTFT коротких попаданий.** Попадание не длиннее окна отбрасывается, такой запрос проходит prefill полностью.
- **KV-cache.** Размер пула не меняется. Группы делят один `BlockPool`, и prefix cache больше не держит в нем SWA-блоки, так что вытесняются только блоки кэшируемых групп. Насколько это поднимает долю хитов, зависит от нагрузки; отдельной метрики движок не печатает.
- **VRAM и время старта.** Размер KV-пула и захват графов флаг не меняет.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: без prefix caching попаданий нет и replay не происходит.
- `--prefix-cache-retention-interval`: управляет плотностью checkpoint'ов sliding-window групп; при включенном replay SWA-группа DeepSeek-V4.1 не кэшируется, и интервал на нее не действует.
- `--prefill-context-parallel-size`: значение больше 1 отключает replay с предупреждением.
- `--kv-transfer-config`: внешние попадания округляются до границы блока, асинхронно загруженный KV проходит replay после прихода.
- `--max-num-batched-tokens`, `--long-prefill-token-threshold`: пересчитываемые токены расходуют бюджет шага и режутся порогом так же, как обычный prefill.

## Типовые проблемы и диагностика

- **Симптом:** в логе `SWA bounded replay needs model runner V2 (only it skips the paged-KV writes of replayed tokens); the sliding-window cache takes part in prefix caching instead.` **Причина:** движок работает на V1 runner. **Действие:** штатный откат; если нужен replay, снять причину выбора V1.
- **Симптом:** `SWA bounded replay is off under prefill context parallelism ...` или `SWA bounded replay is off on ROCm ...`. **Причина:** PCP > 1 или ROCm. **Действие:** штатный откат, флаг на этой конфигурации не работает.
- **Симптом:** доля кэш-хитов по prefix cache ниже ожидаемой на коротких общих префиксах. **Причина:** попадания не длиннее окна отбрасываются. **Проверка:** длина общего префикса против `sliding_window` в `config.json` модели.
- **Подтверждение принятого значения:** отсутствие перечисленных предупреждений при старте модели DeepSeek-V4.1; строка `non-default args: {...}` показывает `swa_bounded_replay: False`, если флаг выключали.

## Примеры

```bash
vllm serve /models/DeepSeek-V4.1-Flash --enable-prefix-caching
```

```bash
vllm serve /models/DeepSeek-V4.1-Flash --enable-prefix-caching --no-swa-bounded-replay --prefix-cache-retention-interval 4096
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/models/deepseek_v41/attention.py`
- `vllm/vllm/models/deepseek_v41/nvidia/model_state.py`
- `vllm/vllm/v1/attention/backends/mla/sparse_swa.py`
- `vllm/vllm/v1/kv_cache_interface.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/core/single_type_kv_cache_manager.py`
- `vllm/tests/v1/core/test_prefix_replay.py`
- `vllm/tests/models/test_deepseek_v41_replay_start.py`
