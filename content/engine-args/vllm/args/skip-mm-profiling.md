---
schema: 1
engine: vllm
primaryName: "--skip-mm-profiling"
title: "--skip-mm-profiling"
summary: Убирает прогон мультимодального энкодера из стартового профилирования памяти. Старт становится короче, но пик активаций энкодера и encoder cache перестают вычитаться из бюджета — за VRAM теперь отвечаете вы.
group: MultiModalConfig
related:
  - --limit-mm-per-prompt
  - --gpu-memory-utilization
  - --kv-cache-memory-bytes
  - --max-num-batched-tokens
  - --enable-mm-embeds
  - --language-model-only
  - --enforce-eager
---

# --skip-mm-profiling

## Кратко

При старте vLLM прогоняет мультимодальный энкодер на фиктивном батче максимального размера, чтобы измерить его пик активаций. Этот пик вычитается из бюджета `--gpu-memory-utilization` до того, как остаток отдаётся под KV-cache.

`--skip-mm-profiling` этот прогон отменяет. Профилируется только языковая часть. Экономится время старта — и ровно на величину неучтённого пика энкодера KV-cache становится больше, чем реально безопасно. Первый же тяжёлый мультимодальный запрос может дать OOM в момент, когда KV-cache уже заполнен.

Парный флаг — `--no-skip-mm-profiling`.

## Оригинальная справка

```text
When enabled, skips multimodal memory profiling and only profiles with
language backbone model during engine initialization.

This reduces engine startup time but shifts the responsibility to users for
estimating the peak memory usage of the activation of multimodal encoder and
embedding cache.
```

## Паспорт аргумента

- Флаги: `--skip-mm-profiling`, `--no-skip-mm-profiling`
- Группа argparse: `MultiModalConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: `True` / `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется; на модели без `multimodal_config` флаг инертен
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.skip_mm_profiling`
- Этап применения: профилирование памяти в worker'е, до расчёта числа KV-блоков

## Что меняет в движке

`GPUModelRunner.profile_run()` (`vllm/v1/worker/gpu_model_runner.py`) при `supports_mm_inputs` смотрит на флаг первым делом:

- флаг включён → в лог уходит `Skipping memory profiling for multimodal encoder and encoder cache.`, и вся мультимодальная ветка профилирования пропускается;
- флаг выключен → строится `MultiModalBudget`, выбирается модальность с наибольшим числом токенов на элемент, собирается батч из `mm_max_items_per_batch` фиктивных элементов, и `self.model.embed_multimodal(...)` реально исполняется на устройстве.

Тот же флаг проверяется в новом раннере `vllm/v1/worker/gpu/model_runner.py:profile_run()`, где он отключает `profile_encoder_cache(...)`.

Важно, что пропускается именно **измерение**, а не резервирование. Планировщик всё равно создаёт `EncoderCacheManager` с `cache_size = mm_budget.encoder_cache_size` (то есть `max_num_batched_tokens`), и encoder cache будет заполняться на реальных запросах — просто эта память не была учтена, когда движок решал, сколько блоков KV-cache себе выделить.

Дальше по цепочке ничего не меняется: `Worker.determine_available_memory()` вычитает из бюджета то, что измерило профилирование, а измерило оно меньше.

## Значения и формат

- Флага нет — `False`: профилирование энкодера выполняется. Это правильный дефолт.
- `--skip-mm-profiling` — `True`.
- `--no-skip-mm-profiling` — явный `False`.
- Флаг не принимает величину «сколько зарезервировать вместо измерения». Если нужен детерминированный размер KV-cache, это делается `--kv-cache-memory-bytes`, а не этим флагом.

## Когда использовать

- Итеративная отладка конфигурации, где старт гоняется десятки раз, а нагрузка заведомо игрушечная.
- Инстанс, у которого размер KV-cache задан явно через `--kv-cache-memory-bytes`: там профилирование и так не определяет ёмкость, и пропуск мультимодальной части сокращает старт без изменения арифметики. Проверьте только, что оставшийся запас покрывает энкодер.
- Модель, чей энкодер не влезает в профилировочный прогон (`OOM` именно на этапе `profile_run`), но реально используется с одним маленьким изображением: тогда `--skip-mm-profiling` плюс вручную заниженный `--gpu-memory-utilization` — рабочий обход. Более честный путь — сначала попробовать `--limit-mm-per-prompt` с реальными числами.
- Не используйте на управляемом сервере с боевой нагрузкой: вы теряете единственный автоматический механизм, который учитывает энкодер в бюджете, и получаете OOM не при старте, а под трафиком.

## Влияние на производительность и память

- **VRAM.** Главный эффект: `non_kv_cache_memory` занижается на пик энкодера, KV-cache получается больше номинально безопасного. Разница тем больше, чем крупнее `--limit-mm-per-prompt` и ViT.
- **Encoder cache.** Резервируется и используется как обычно, но не учтён в бюджете.
- **Время старта.** Сокращается на длительность прогона энкодера с максимальным батчем — на больших ViT это единицы-десятки секунд.
- **Throughput.** Косвенно вырастает из-за большего KV-cache — ровно до первого OOM.
- **Latency.** Не меняется.

## Взаимодействие с другими аргументами

- `--gpu-memory-utilization`: бюджет остаётся прежним, но из него вычитается меньше. Компенсировать флаг следует понижением utilization, и величину понижения придётся оценивать вручную.
- `--kv-cache-memory-bytes`: при заданном значении профилирование памяти и так пропускается целиком; этот флаг тогда влияет только на время старта.
- `--limit-mm-per-prompt`: определяет размер профилировочного батча. С включённым `--skip-mm-profiling` лимиты продолжают ограничивать запросы, но больше не отражаются в измеренном пике.
- `--max-num-batched-tokens`: задаёт `encoder_cache_size` — ту самую память, которую флаг перестаёт учитывать.
- `--enable-mm-embeds` в embedding-only режиме: прогон энкодера пропускается и без флага (`Skipping encoder profiling for embedding-only mode ...`).
- `--language-model-only`: мультимодального профилирования нет по построению, флаг избыточен.
- `--enforce-eager`: снимает из бюджета оценку CUDA graphs; вместе с этим флагом получается сразу две неучтённые статьи расхода — сочетание рискованное.

## Типовые проблемы и диагностика

- **Симптом:** OOM на первом запросе с большим изображением/видео, при том что старт прошёл и `GPU KV cache size` выглядит щедро. **Причина:** пик энкодера не учтён. **Лечение:** убрать флаг либо понизить `--gpu-memory-utilization` и/или `--limit-mm-per-prompt`.
- **Симптом:** после включения флага KV-cache вырос, а стабильность упала. **Проверка:** сравните `Available KV cache memory: X GiB` в логах с флагом и без. Разница — и есть цена энкодера, которую теперь надо покрыть вручную.
- **Симптом:** OOM внутри `profile_run` (без флага). **Причина:** профилировочный батч слишком большой. **Лечение:** сначала `--limit-mm-per-prompt` с реальными значениями; `--skip-mm-profiling` — крайняя мера, которая проблему прячет, а не решает.
- **Подтверждение принятого значения:** строка `Skipping memory profiling for multimodal encoder and encoder cache.` в стартовом логе; при выключенном флаге вместо неё появляется `Encoder cache will be initialized with a budget of N tokens, and profiled with M <modality> items of the maximum feature size.`

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --skip-mm-profiling --gpu-memory-utilization 0.75 --limit-mm-per-prompt '{"image": 1, "video": 0}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --skip-mm-profiling --kv-cache-memory-bytes 8G --max-model-len 16384
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/worker/gpu/model_runner.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/multimodal/encoder_budget.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/docs/configuration/conserving_memory.md`
