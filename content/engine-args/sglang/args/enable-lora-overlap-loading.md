---
schema: 1
engine: sglang
primaryName: "--enable-lora-overlap-loading"
title: "--enable-lora-overlap-loading"
summary: Загружает веса адаптеров на отдельном CUDA-stream'е, пряча H2D-копию за вычислениями. Требует закрепления весов в RAM и потому жестко ограничивает `--max-loaded-loras` двойным числом слотов; выключен по умолчанию не случайно.
group: lora
related:
  - --max-loaded-loras
  - --max-loras-per-batch
  - --enable-lora
  - --lora-paths
  - --lora-eviction-policy
  - --max-lora-rank
---

# --enable-lora-overlap-loading

## Кратко

Без этого флага адаптеры въезжают в слоты пула одним пакетом непосредственно перед прогоном батча — синхронная H2D-копия на критическом пути. С флагом каждый адаптер грузится по одному на отдельном stream'е, и планировщик берет его в батч только когда копия завершилась. Апстрим сообщает о снижении медианного TTFT примерно на 35 % в неблагоприятных условиях, но честно перечисляет две расплаты: закрепление весов в RAM (отсюда ассерт на `--max-loaded-loras`) и потеря части многоадаптерных prefill-батчей.

## Оригинальная справка

```text
Enable asynchronous LoRA weight loading in order to overlap H2D transfers with GPU compute. This should be enabled if you find that your LoRA workloads are bottlenecked by adapter weight loading, for example when frequently loading large LoRA adapters.
```

## Паспорт аргумента

- Флаги: `--enable-lora-overlap-loading`
- Группа: `lora`
- Тип значения: `Optional[bool]`; в argparse — `action="store_true"` с `default=None`
- Допустимые значения: значения не принимает — флаг присутствия
- Значение по умолчанию: `null`
- Эффективное значение: при включенной LoRA `check_lora_server_args` фиксирует `None` в `False`
- Где объявлен: `ServerArgs.enable_lora_overlap_loading`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (валидация) → `Scheduler.init_lora_overlap_loader` → отбор заявок в батч и загрузка весов

## Что меняет в движке

### Обязательная связка с `--max-loaded-loras`

```python
if self.enable_lora_overlap_loading:
    max_loaded_loras_limit = self.max_loras_per_batch * 2
    assert (
        self.max_loaded_loras is not None
        and self.max_loaded_loras <= max_loaded_loras_limit
    ), (
        "Enabling LoRA overlap loading requires pinning LoRA adapter weights in CPU memory, "
        f"so --max-loaded-loras must be less than or equal to double --max-loras-per-batch: {max_loaded_loras_limit}"
    )
```

Флаг делает `--max-loaded-loras` **обязательным**: незаданное значение ассерт не проходит. Ограничение сверху существует потому, что асинхронная копия требует pinned-памяти на стороне хоста, а она конечна.

### Закрепление весов в RAM

`LoRAMemoryPool._get_maybe_cached_weight_for_transfer` при выключенном флаге вызывает `weight.pin_memory()` на каждый перенос (временный буфер), а при включенном — **кеширует** закрепленную копию по ключу веса:

```python
if not self.enable_lora_overlap_loading:
    return weight.pin_memory()
cached_weight = pinned_weight_store.get(cache_key)
if cached_weight is None:
    cached_weight = weight.pin_memory()
    pinned_weight_store[cache_key] = cached_weight
```

То есть веса всех зарегистрированных адаптеров постепенно оседают в закрепленной памяти и остаются там до выгрузки адаптера. Именно эту память и лимитирует `2 × max_loras_per_batch`.

### Как меняется планирование

`Scheduler._can_schedule_lora_req` вместо пакетной проверки `validate_lora_batch` вызывает `LoRAOverlapLoader.try_overlap_load_lora` (`sglang/python/sglang/srt/lora/lora_overlap_loader.py`):

1. сначала «дренируются» завершенные асинхронные загрузки — их CUDA-события ожидаются текущим stream'ом и убираются из карты in-flight;
2. если адаптер уже грузится (`LOADING`) — заявка **в этот батч не попадает**, возвращается `False`;
3. если адаптера в пуле нет (`NOT_LOADED`) — проверяется, влезает ли он вместе с уже запущенными загрузками (`validate_lora_batch(running | in-flight | new)`), и при успехе запускается загрузка на `load_stream`, а заявка всё равно пропускается в этом раунде;
4. если адаптер уже резидентен (`LOADED`) — заявка допускается.

Соответственно `ForwardBatch` в этом режиме **не** вызывает `fetch_new_loras` перед прогоном (`forward_batch_info.py`: пакетная загрузка выполняется только при выключенном флаге).

Отсюда и второе последствие, о котором предупреждает апстрим: адаптеры становятся доступны в разное время, поэтому планировщик реже собирает несколько адаптеров в один prefill-батч. Когда загрузка весов и так была дешевой относительно prefill, суммарный TTFT от этого растет.

## Значения и формат

- Флаг без значения; выключить можно только его отсутствием.
- Требует явного `--max-loaded-loras` в диапазоне `[--max-loras-per-batch, 2 × --max-loras-per-batch]`.
- Взаимодействует только с LoRA-трактом; при выключенной LoRA поле остается `None` и не проверяется.

## Когда использовать

- Замеренный симптом: высокая ротация адаптеров, «толстые» адаптеры (большой ранг или широкий набор целевых модулей) и/или узкий PCIe. Апстрим прямо называет этот сценарий («high adapter churn, heavy adapter weights, or PCIe-bottlenecked workloads»).
- Слотов заметно меньше, чем активных адаптеров, и в профиле видно ожидание H2D-копий перед prefill.
- **Не включайте по умолчанию.** Флаг выключен намеренно: при дешевой загрузке адаптеров потеря многоадаптерной батчевки перевешивает выигрыш, и TTFT растет.
- **Не включайте**, если не готовы ограничить `--max-loaded-loras` — иначе сервер просто не стартует.

## Влияние на производительность и память

- **RAM хоста, закрепленная.** Главная цена. Веса каждого зарегистрированного адаптера остаются pinned до его выгрузки; эта память не свопится и не отдается ОС. Верхняя граница задается лимитом `2 × --max-loras-per-batch` на число адаптеров.
- **TTFT.** До −35 % по медиане в неблагоприятных условиях (по бенчмарку апстрима); при благоприятных — рост из-за дробления prefill-батчей.
- **Throughput.** Может снижаться: меньше адаптеров в одном prefill-батче.
- **VRAM.** Не меняется: размер пула определяется `--max-loras-per-batch` и `--max-lora-rank`.
- **CUDA-ресурсы.** Дополнительный stream и по одному CUDA-событию на каждую загрузку в полете.

## Взаимодействие с другими аргументами

- `--max-loaded-loras`: обязателен и ограничен сверху удвоенным числом слотов.
- `--max-loras-per-batch`: задает и число слотов, и границу предыдущего лимита; при подсчете вместимости учитываются ещё и адаптеры, загрузка которых в полете.
- `--lora-eviction-policy`: логика выбора жертвы не меняется, меняется только стоимость промаха.
- `--lora-paths` с `pinned`: закрепление в GPU-слоте (другой механизм, не путать с pinned-памятью хоста).
- `--max-lora-rank`, `--lora-target-modules`: определяют вес одного адаптера, то есть и объем закрепленной памяти, и длительность копии.
- В arriero закрепленная память относится к host-пулу инстанса и, в отличие от обычной, никогда не отдается под давлением — учитывайте её в memory draw (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `AssertionError: Enabling LoRA overlap loading requires pinning LoRA adapter weights in CPU memory, so --max-loaded-loras must be less than or equal to double --max-loras-per-batch: N` — самая частая ошибка: `--max-loaded-loras` не задан или задан слишком большим.
- `ValueError: LoRA pinned weight cache key collision for '<key>': cached shape=..., dtype=...; new shape=..., dtype=...` — под одним ключом кеша оказались веса разной формы; это указывает на рассинхрон адаптеров, а не на проблему настройки.
- TTFT вырос после включения — ровно тот случай, о котором предупреждает апстрим: загрузка не была узким местом, а батчевка развалилась. Выключайте.
- RAM хоста растет и не возвращается — это pinned-кеш; он освобождается только при выгрузке адаптера.
- Заявка к адаптеру «зависает» на один-два раунда планирования — нормальное поведение: пока загрузка в полете, адаптер в батч не берется.
- События загрузки пишутся на уровне `debug` (`Loading LoRA adapter <id> asynchronously`); значение аргумента видно в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 256 --lora-target-modules all --max-loras-per-batch 2 --max-loaded-loras 4 --enable-lora-overlap-loading
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-paths a=/models/lora/a b=/models/lora/b --max-loras-per-batch 4 --max-loaded-loras 8 --enable-lora-overlap-loading --lora-backend csgmv
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/lora_overlap_loader.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/model_executor/forward_batch_info.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
