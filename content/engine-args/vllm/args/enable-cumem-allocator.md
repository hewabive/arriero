---
schema: 1
engine: vllm
primaryName: "--enable-cumem-allocator"
title: "--enable-cumem-allocator"
summary: Переводит выделение весов и KV-cache в собственный CUDA-аллокатор vLLM с именованными пулами. В этом commit'е единственный потребитель этих пулов — sleep mode, который включает аллокатор сам.
group: ModelConfig
related:
  - --enable-sleep-mode
  - --gpu-memory-utilization
  - --kv-cache-memory-bytes
  - --tensor-parallel-size
---

# --enable-cumem-allocator

## Кратко

`CuMemAllocator` — аллокатор поверх низкоуровневого CUDA virtual memory API, который умеет отвязывать физические страницы от виртуальных адресов. Он выделяет память в помеченные пулы: `weights` и `kv_cache`.

Практический смысл ровно один: пулы можно освободить и восстановить, не пересоздавая тензоры. Это механизм sleep/wake. Sleep mode включает аллокатор автоматически, поэтому отдельный флаг нужен только в редком случае «пулы нужны, а sleep — нет».

## Оригинальная справка

```text
Enable the custom cumem allocator to leverage advanced GPU memory
allocation features such as multi-node NVLink support.

Sleep mode automatically enables this allocator. Only cuda and hip
platforms are supported.
```

## Паспорт аргумента

- Флаги: `--enable-cumem-allocator`, `--no-enable-cumem-allocator`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-cumem-allocator` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: принудительно `True`, если задан `--enable-sleep-mode` и платформа cuda-alike (лог `Enabling cumem allocator because sleep mode requires it.`); при `True` на платформе без расширения `vllm.cumem_allocator` старт падает
- Где объявлен: `vllm/config/model.py:ModelConfig.enable_cumem_allocator`
- Этап применения: `ModelConfig.__post_init__` (валидация доступности) → инициализация worker'а: загрузка весов и выделение KV-cache

## Что меняет в движке

**Валидация.** В `ModelConfig.__post_init__` после блока sleep mode: если аллокатор включён и `current_platform.is_cumem_allocator_available()` вернул `False`, поднимается `ValueError("cumem allocator is not supported on current platform.")`. Доступность — это булев флаг `cumem_available` из `vllm/device_allocator/cumem.py`, который выставляется в `True` только при успешном импорте скомпилированного расширения `vllm.cumem_allocator`. То есть проверяется не «CUDA есть», а «сборка vLLM содержит это расширение».

**Использование.** Единственная точка — `Worker._maybe_get_memory_pool_context(tag)` (`vllm/v1/worker/gpu_worker.py`):

- на cuda-alike без `enable_cumem_allocator` возвращается `nullcontext()`, то есть обычный аллокатор PyTorch;
- на XPU роль переключателя играет `enable_sleep_mode`;
- на CPU всегда `nullcontext()`;
- иначе возвращается `allocator.use_memory_pool(tag=tag)`.

Контекст открывается дважды: вокруг загрузки модели (`tag="weights"`) и вокруг `initialize_kv_cache` (`tag="kv_cache"`). Перед выделением пула `weights` стоит проверка `assert allocator.get_current_usage() == 0` с сообщением «CuMem allocator can only be used for one instance per process.» — два инстанса vLLM в одном процессе с этим аллокатором невозможны.

Метаданные KV-zero (`_init_kv_zero_meta`) намеренно строятся **вне** пула, чтобы служебные тензоры не исчезали при sleep/wake.

При завершении работы `CuMemAllocator.instance.release_pools()` освобождает пулы.

**О «multi-node NVLink support» из справки.** В этом commit'е checkout'а в дереве нет ни одного потребителя пулов, кроме sleep/wake-пути (`vllm/device_allocator/sleep_mode_backend.py` и `gpu_worker.py`). Формулировка описывает возможности низкоуровневого API, а не отдельную функциональность, включаемую этим флагом. Не ждите от флага самого по себе прироста — ждите возможности усыплять инстанс.

## Значения и формат

- Булев флаг без значения.
- «Не задан» = `False` = обычный кэширующий аллокатор PyTorch.
- Только CUDA и HIP (ROCm). На других платформах включение приведёт к отказу старта либо не даст эффекта.

## Когда использовать

- Практически никогда напрямую: если нужен sleep mode, задавайте `--enable-sleep-mode`, аллокатор включится сам.
- Осмысленный самостоятельный случай — эксперимент с фрагментацией VRAM: пулы отделяют веса от KV-cache в отдельные виртуальные диапазоны, что меняет картину фрагментации при долгой работе.
- **Не включайте «на всякий случай»** на управляемом сервере: это меняет путь аллокации всей модели, а профилирование памяти и оценка CUDA-graph-пула калибровались на штатном аллокаторе.

## Влияние на производительность и память

- **VRAM.** Общий бюджет по-прежнему задаёт `--gpu-memory-utilization`; аллокатор меняет способ выделения, а не размер. Пулы выделяются страницами низкоуровневого API — накладные расходы на выравнивание могут отличаться от кэширующего аллокатора PyTorch.
- **Время старта.** Дополнительных шагов нет, но выделение через `cuMem*` дороже, чем из кэша PyTorch; на больших моделях это заметно в секундах, не в минутах.
- **Throughput.** На установившемся режиме forward не затрагивается: аллокации происходят на старте.
- **Ограничение процесса.** Один инстанс на процесс (см. assert выше). Для нескольких моделей на карте нужны отдельные процессы — в arriero это и так отдельные инстансы.

## Взаимодействие с другими аргументами

- `--enable-sleep-mode`: включает этот аллокатор принудительно на cuda-alike. Обратной зависимости нет: аллокатор без sleep mode работает.
- `--gpu-memory-utilization`: задаёт бюджет; аллокатор не меняет расчёт `request_memory()`/`determine_available_memory()`.
- `--kv-cache-memory-bytes`: пропускает профилирование и задаёт размер KV-cache байтами; пул `kv_cache` при этом всё равно используется.
- `--tensor-parallel-size`: у каждого worker-процесса свой экземпляр аллокатора и свой набор пулов, поэтому ограничение «один инстанс на процесс» шардированию не мешает.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: cumem allocator is not supported on current platform.` **Причина:** в сборке нет расширения `vllm.cumem_allocator` (или платформа не CUDA/HIP). **Проверка:** `python -c "from vllm.device_allocator.cumem import cumem_available; print(cumem_available)"` в окружении инстанса. **Лечение:** снять флаг либо взять сборку с расширением.
- **Симптом:** `AssertionError: CuMem allocator can only be used for one instance per process.` **Причина:** второй `LLM`/движок в том же процессе. **Лечение:** отдельный процесс на инстанс.
- **Симптом:** в логе `Enabling cumem allocator because sleep mode requires it.`, хотя флаг не задавался. **Причина:** штатное действие `--enable-sleep-mode`.
- **Симптом:** после долгой работы VRAM «расползается» иначе, чем без флага. **Причина:** другая стратегия аллокации. **Проверка:** строка профилирования `Free memory on device (...). Desired GPU memory utilization is (...). Actual usage is ... for consumed memory (weights + non-torch), ... for peak activation, and ... for CUDAGraph memory.` — сравните с прогоном без флага.
- **Подтверждение принятого значения:** отдельной строки нет; косвенно — сообщение `CuMemAllocator: sleep freed %.2f GiB memory in total` при усыплении.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-cumem-allocator --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --enable-cumem-allocator --kv-cache-memory-bytes 8G --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/device_allocator/cumem.py`
- `vllm/vllm/device_allocator/sleep_mode_backend.py`
- `vllm/vllm/device_allocator/__init__.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/platforms/interface.py`
