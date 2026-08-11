---
schema: 1
engine: sglang
primaryName: "--pre-warm-nccl"
title: "--pre-warm-nccl"
summary: Делает один фиктивный all-reduce по TP-группе сразу после инициализации распределенного слоя, чтобы NCCL/RCCL не создавал коммуникатор на первом реальном запросе. Дешевый способ убрать выброс TTFT после старта на многокарточной конфигурации.
group: exec.comm
related:
  - --tp-size
  - --pp-size
  - --ep-size
  - --device
  - --dist-timeout
  - --disable-custom-all-reduce
  - --watchdog-timeout
---

# --pre-warm-nccl

## Кратко

NCCL создает внутренние ресурсы коммуникатора лениво — на первом коллективе. Если сервер поднялся и стоит без нагрузки, эта работа достанется первому пользовательскому запросу и добавит ему сотни миллисекунд к TTFT. `--pre-warm-nccl` вставляет в конец `init_torch_distributed` один `all_reduce` над тензором из одного элемента и синхронизацию, после чего пишет в лог, сколько это заняло. Флаг применим только при `tp_size > 1`, `pp_size > 1` или `ep_size > 1` — на одной карте прогревать нечего. Обратите внимание на расхождение: справка утверждает, что для AMD флаг включен по умолчанию, но в исходниках checkout'а декларативный default равен `false` и ни один обработчик его не поднимает.

## Оригинальная справка

```text
Pre-warm NCCL/RCCL communicators during startup to reduce P99 TTFT cold-start latency. Default: enabled for AMD/HIP (RCCL), disabled for NVIDIA/CUDA (NCCL).
```

## Паспорт аргумента

- Флаги: `--pre-warm-nccl`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: единственное переопределение — сброс в `False` на платформе вне CUDA/HIP/NPU (`_handle_nccl_pre_warm`) с предупреждением `pre_warm_nccl is only applicable for CUDA or HIP hardware or NPU hardware. Ignoring pre_warm_nccl setting on current hardware.` Обещанного справкой автоматического включения на AMD в коде checkout'а нет: ни `_handle_amd_specifics`, ни реестр `arg_groups/overrides.py`, ни платформенные хуки поля не трогают. Если вам нужен прогрев на ROCm — задавайте флаг явно
- Где объявлен: `ServerArgs.pre_warm_nccl`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (`_handle_nccl_pre_warm`) → `init_torch_distributed` после `_init_parallel_groups`, до загрузки весов

## Что меняет в движке

В `sglang/python/sglang/srt/distributed/bootstrap.py`:

```python
if server_args.pre_warm_nccl and (ps.tp_size > 1 or ps.pp_size > 1 or ps.moe_ep_size > 1):
    _prewarm_nccl(tp_size=ps.tp_size, pp_size=ps.pp_size, moe_ep_size=ps.moe_ep_size)
```

Сама функция короткая: берет `get_tp_group().device_group`, делает `dist.all_reduce` над `torch.zeros(1)`, вызывает `current_platform.synchronize()` и логирует `NCCL/RCCL/HCCL warmup completed in X.XXXs (tp_size=…, pp_size=…, ep_size=…)`.

Что именно это «греет»: установление соединений между рангами, выбор алгоритма и протокола, выделение внутренних буферов NCCL/RCCL/HCCL, а на многоузловой конфигурации — установление RDMA/сокет-соединений. Обратите внимание, что прогревается **только TP-группа**: PP- и EP-группы в проверке участвуют как условие, но коллектив выполняется на `tp_group`. Для чисто pipeline-конфигурации (`--tp-size 1 --pp-size 2`) прогрев формально выполнится, но по вырожденной TP-группе.

Прогрев не относится к custom all-reduce, symmetric memory и mscclpp: их буферы создаются в конструкторе `GroupCoordinator`, то есть еще раньше и безусловно.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- На одноранговой конфигурации выполняется проверка и ничего не происходит — ошибки не будет.
- На CPU/MPS/XPU-хосте флаг сбрасывается в `__post_init__` с предупреждением.

## Когда использовать

- Многокарточный инстанс, который живет с длинными паузами без нагрузки, и вам важен P99 TTFT. Это ровно тот случай, для которого флаг сделан.
- Инстанс, который arriero запускает по запросу через autostart прокси: первый запрос после старта и так платит за загрузку весов и захват графов, и добавлять к нему еще инициализацию NCCL смысла нет. Флаг переносит эту стоимость в фазу старта, которую прокси и так ждет.
- Не включайте на одной карте — эффекта нет.
- Не рассчитывайте, что флаг лечит зависание на `Init torch distributed begin.`: если группа не собирается, прогрев произойдет уже после сборки и на проблему не влияет.

## Влияние на производительность и память

- **Время старта.** Плюс время создания коммуникатора — обычно доли секунды на одном узле, заметно больше на многоузловой конфигурации с RDMA. Ровно это время и печатается в лог.
- **VRAM.** Косвенно: внутренние буферы NCCL выделяются раньше, а не при первом запросе. Итоговый объем тот же, но он попадет в измерение свободной памяти **до** расчета KV-пула, что делает оценку честнее.
- **Latency.** Снимает разовый выброс TTFT у первого запроса после старта. На установившемся режиме не влияет.
- **Throughput.** Не влияет.
- **Хост.** Не меняется.

## Взаимодействие с другими аргументами

- `--tp-size` / `--pp-size` / `--ep-size`: любое значение больше 1 включает выполнение прогрева.
- `--device`: на не-CUDA/HIP/NPU платформе флаг сбрасывается.
- `--dist-timeout`: прогрев идет уже после успешной сборки группы, поэтому таймаут инициализации на него не влияет; но на многоузловом запуске сам коллектив подчиняется тому же таймауту процесс-группы.
- `--disable-custom-all-reduce`: прогревается путь `torch.distributed`; custom-ядро греется отдельно и раньше, при создании группы.
- `--watchdog-timeout`: увеличенное время старта учитывайте, если вы его ужимали.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан на ROCm «потому что там он и так включен» — и ничего не меняется без него. **Причина:** в этом checkout'е автоматического включения для AMD нет, несмотря на текст справки. **Решение:** задавать флаг явно.
- **Симптом:** предупреждение `pre_warm_nccl is only applicable for CUDA or HIP hardware or NPU hardware.` **Причина:** запуск на CPU/XPU/MPS. **Решение:** убрать флаг.
- **Симптом:** старт стал дольше на многоузловой конфигурации. **Причина:** ожидаемая — установление межузловых соединений перенесено в старт. **Проверка:** строка `NCCL/RCCL/HCCL warmup completed in …`.
- **Симптом:** строки про warmup нет, хотя флаг задан. **Причина:** `tp_size == pp_size == ep_size == 1` либо флаг сброшен платформенной проверкой. **Проверка:** итоговый дамп `server_args=` при старте.
- **В arriero:** строка о завершении прогрева проходит фильтр лога инстанса и видна в UI; при политике вытеснения `idle-only` и частых стартах/остановках инстанса флаг заметно ровнее делает первый запрос после autostart.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 4 --pre-warm-nccl
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --ep-size 8 --moe-a2a-backend deepep --pre-warm-nccl
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- `sglang/docs/docs/hardware-platforms/ascend-npus/reference/support_features.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
