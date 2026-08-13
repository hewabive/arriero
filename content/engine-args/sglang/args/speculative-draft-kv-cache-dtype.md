---
schema: 1
engine: sglang
primaryName: "--speculative-draft-kv-cache-dtype"
title: "--speculative-draft-kv-cache-dtype"
summary: Задает тип KV-кеша отдельно для draft-модели, не трогая KV целевой. Нужен потому, что draft-пул выделяется на то же число токенов, что и целевой, и у многослойного драфта съедает сопоставимую VRAM; `fp8_e4m3` уменьшает его вдвое.
group: spec
related:
  - --kv-cache-dtype
  - --speculative-algorithm
  - --speculative-draft-attention-backend
  - --speculative-draft-model-path
  - --speculative-num-steps
  - --mem-fraction-static
  - --page-size
---

# --speculative-draft-kv-cache-dtype

## Кратко

`--kv-cache-dtype` действует сразу на оба KV-пула — целевой модели и draft-модели. Этот аргумент отвязывает draft: его пул получает собственный тип, а целевой остается как был. Практический смысл в том, что draft-пул **не маленький**: он выделяется на то же количество токенов, что и целевой (аллокатор и индексное пространство слотов у них общие), поэтому у драфта на несколько слоев он стоит гигабайты. Квантование только драфта сбрасывает эту цену, не трогая качество и скорость основного KV-пути.

Освободившаяся память **не превращается в KV-емкость сама по себе**: она остается свободной VRAM, и чтобы ее забрал KV-пул, нужно поднять `--mem-fraction-static`.

## Оригинальная справка

```text
KV cache dtype for the speculative draft model only. The draft pool is allocated with one slot per target token (draft and target share a slot index space), so for a small draft it can still rival the target pool: a 5-layer DFLASH draft costs 10240 bytes/token in bf16. Setting fp8_e4m3 halves the draft pool; the saving shows up as free device memory, so raise --mem-fraction-static to convert it into KV capacity. Default follows --kv-cache-dtype.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-kv-cache-dtype`
- Группа: `spec`
- Тип значения: строка (`Optional[str]`)
- Допустимые значения: `auto`, `fp8_e5m2`, `fp8_e4m3`, `bf16`, `bfloat16`. Список **уже**, чем у `--kv-cache-dtype`: `mxfp8`, `nvfp4` и `fp4_mx_block16` резолвер `configure_kv_cache_dtype` понимает, но в `choices` этого флага их нет, и argparse отвергнет их до старта
- Значение по умолчанию: `null` — draft берет значение `--kv-cache-dtype`
- Эффективное значение: `auto` резолвится так же, как у `--kv-cache-dtype`: если у чекпоинта драфта в `quant_config.kv_cache_quant_algo` стоит `FP8`, берется `torch.float8_e4m3fn` (на ROCm — `fp8_dtype`), иначе compute-dtype модели. Отдельно есть жесткое переопределение для DFLASH на `fa4` (см. ниже)
- Где объявлен: `ServerArgs.speculative_draft_kv_cache_dtype`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `ModelRunner.configure_kv_cache_dtype()` у draft-воркера → выделение draft-KV-пула → выбор путей cast/descale в attention-backend'е драфта

## Что меняет в движке

Единственная точка чтения — `configure_kv_cache_dtype` (`mem_cache/kv_cache_dtype.py`), и первая же ветка в ней:

```python
if is_draft_worker and speculative_draft_kv_cache_dtype is not None:
    server_args_kv_cache_dtype = speculative_draft_kv_cache_dtype
```

То есть значение просто подменяет `--kv-cache-dtype` **в контексте draft-воркера**, после чего работает общий резолвер. Целевой `ModelRunner` вызывает ту же функцию с `is_draft_worker=False` и этого аргумента не видит вовсе.

Дальше результат живет в двух местах:

- `ModelRunner.kv_cache_dtype` — реальный `torch.dtype`, с которым выделяется draft-пул;
- `ModelRunner.kv_cache_dtype_str` — строковый тег **этого** runner'а. Он намеренно не берется из процесс-глобального набора аргументов: draft-runner свои аргументы туда не публикует, и backend внимания драфта, прочитав глобальное значение, получил бы тип целевой модели и погнал бы KV драфта по неверным путям cast/descale.

Одно переопределение отменяет заданное значение молча (но с записью в лог): если алгоритм из семейства DFLASH, backend внимания драфта — `fa4`, а полученный тип отличается от compute-dtype, KV драфта возвращается к compute-dtype, а тег становится `auto`. Причина в ядре: `fa4` требует `K.dtype == Q.dtype` и не умеет читать квантованный KV.

Тот же резолвер вызывается заранее, без модели, из `spec_aux_hidden_state.py` — чтобы посчитать цену одного токена draft-KV (`dflash_draft_cell_size_per_token`) до выделения памяти. Так что заданный тип влияет и на априорный расчет размеров пулов, а не только на фактическую аллокацию.

## Значения и формат

- Не задан — draft повторяет `--kv-cache-dtype`. Это не то же самое, что `auto`: если целевой KV идет в `fp8_e5m2`, то и draft пойдет в `fp8_e5m2`.
- `auto` — «решить по чекпоинту драфта»: FP8 в его `quant_config` включит `fp8_e4m3`, иначе compute-dtype. Это способ **отменить** унаследованное от целевой модели квантование драфта.
- `fp8_e4m3` — рабочий вариант для экономии: вдвое меньше bf16.
- `fp8_e5m2` — тот же размер, шире экспонента, меньше мантисса; на ROCm обе формы fp8 отображаются в один нативный `fp8_dtype`.
- `bf16`/`bfloat16` — синонимы, оба дают `torch.bfloat16`. Полезны, чтобы явно снять квантование с драфта при квантованном целевом KV.

## Когда использовать

- Драфт многослойный (DFLASH, EAGLE3 с несколькими слоями, отдельная draft-модель), запуск упирается в VRAM, а трогать точность целевого KV не хочется — задайте `fp8_e4m3` и поднимите `--mem-fraction-static` на освободившуюся долю.
- Целевой KV уже в fp8, а на драфте это дает заметную просадку `accept len` — верните драфту `bf16` точечно.
- Draft — MTP-голова того же чекпоинта, слоев один-два: экономить нечего, аргумент не нужен.
- Связка DFLASH + `--speculative-draft-attention-backend fa4`: задавать бессмысленно, значение все равно вернут к compute-dtype.

## Влияние на производительность и память

- Память — основной эффект. Draft-пул считается по числу токенов целевого пула, а не по своему «маленькому» размеру: цена — `2 × слои × kv-головы × head_dim × байт_на_элемент` на токен (в справке приведен ориентир: 5-слойный DFLASH-драфт — 10240 байт на токен в bf16, то есть 10 ГиБ на миллион токенов). Переход на fp8 режет это вдвое.
- Освободившееся не отдается KV автоматически: `--mem-fraction-static` задает статическую долю, и без ее повышения экономия останется просто свободной VRAM.
- Скорость: fp8-KV у драфта добавляет cast/descale на draft-шагах, но обычно окупается ростом пула. Влияние на `accept len` возможно и проверяется только замером — draft и так приблизительный, и лишняя потеря точности бьет по проценту принятых токенов.
- На старт не влияет: тип выбирается до аллокации, дополнительной конвертации весов нет.

## Взаимодействие с другими аргументами

- `--kv-cache-dtype`: источник значения по умолчанию; этот флаг перебивает его только для драфта.
- `--speculative-draft-attention-backend`: `fa4` в связке с DFLASH отменяет квантованный draft-KV; остальные fp8-совместимые backend'ы сохраняют заданный тип.
- `--speculative-algorithm`: определяет, создается ли draft-`ModelRunner` вообще и попадает ли запуск в DFLASH-ветку переопределения.
- `--mem-fraction-static`: без его повышения экономия не конвертируется в KV-емкость.
- `--speculative-num-steps`, `--speculative-eagle-topk`: определяют нагрузку на draft-пул по числу шагов, но не его размер в токенах.
- `--page-size`: общий для обоих пулов, на тип не влияет.

## Типовые проблемы и диагностика

- **Симптом:** задан `fp8_e4m3`, а размер draft-пула не изменился. **Причина:** DFLASH на `fa4` вернул compute-dtype. **Проверка:** в логе строка `DFLASH fa4 draft: overriding KV cache dtype ... -> ... (fa4 needs K.dtype == Q.dtype; cannot read the target's quantized KV).` **Лечение:** сменить backend драфта или смириться.
- **Симптом:** `argument --speculative-draft-kv-cache-dtype: invalid choice: 'mxfp8'`. **Причина:** у флага более узкий список, чем у `--kv-cache-dtype`. **Лечение:** `fp8_e4m3` либо квантование целевого KV через `--kv-cache-dtype`.
- **Симптом:** VRAM освободилась, но контекст не вырос. **Причина:** `--mem-fraction-static` не поднят. **Проверка:** строка с итоговым размером KV-пула при старте — число токенов должно измениться.
- **Симптом:** упал `accept len` после включения fp8 на драфте. **Причина:** потеря точности в draft-KV. **Лечение:** `bf16` для драфта, экономию искать в другом месте.
- Что смотреть: дамп `server_args=` (`entrypoints/engine.py`) подтверждает принятое значение, дальше — логи выделения KV-пулов draft- и target-воркеров.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --speculative-algorithm DFLASH --speculative-draft-model-path /models/DeepSeek-V3.2-DFlash-Draft --speculative-draft-kv-cache-dtype fp8_e4m3 --mem-fraction-static 0.9
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-70B-Instruct --kv-cache-dtype fp8_e4m3 --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-70B --speculative-draft-kv-cache-dtype bf16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_dtype.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/spec_aux_hidden_state.py`
- `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`
- `sglang/python/sglang/srt/speculative/base_spec_worker.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
