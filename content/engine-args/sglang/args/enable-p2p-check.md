---
schema: 1
engine: sglang
primaryName: "--enable-p2p-check"
title: "--enable-p2p-check"
summary: Возвращает настоящую проверку P2P-доступа между картами, которую SGLang по умолчанию заглушает константой True. Нужен, когда custom all-reduce молча ломает данные на хосте без реального P2P.
group: parallel
related:
  - --disable-custom-all-reduce
  - --tp-size
  - --gpu-id-step
  - --base-gpu-id
  - --enable-mscclpp
  - --enable-torch-symm-mem
---

# --enable-p2p-check

## Кратко

Имя флага обманчиво: проверка P2P в апстрим-коде **существует всегда**, а SGLang по умолчанию ее отключает. При незаданном `--enable-p2p-check` вызывается `monkey_patch_p2p_access_check()`, который подменяет `gpu_p2p_access_check` на `lambda *a, **kw: True` — «считаем, что P2P есть». Комментарий в коде честно предупреждает: «We assume the p2p access is always allowed, which can be wrong for some setups». Флаг возвращает настоящую проверку — дорогую (запуск двух дочерних процессов на пары карт), но кешируемую, и нужен ровно там, где предположение неверно.

## Оригинальная справка

```text
Enable P2P check for GPU access, otherwise the p2p access is allowed by default.
```

## Паспорт аргумента

- Флаги: `--enable-p2p-check`
- Группа: `parallel`
- Тип значения: bool (`store_true`)
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False` — то есть **проверка отключена**, а P2P считается доступным
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.enable_p2p_check`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `init_torch_distributed`, до создания групп и до инициализации custom all-reduce

## Что меняет в движке

Единственная точка (`sglang/python/sglang/srt/distributed/bootstrap.py`):

```python
if not server_args.enable_p2p_check:
    monkey_patch_p2p_access_check()
```

`monkey_patch_p2p_access_check` (`sglang/python/sglang/srt/utils/common.py`) делает две вещи: подменяет `gpu_p2p_access_check` на константу `True` и обнуляет `CustomAllreduce.__del__`, чтобы не шуметь предупреждениями.

С флагом работает настоящая процедура (`sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce_utils.py`). `can_use_custom_all_reduce_with_nvlink` последовательно отсеивает случаи, где custom all-reduce неприменим:

- `world_size == 1`, многоузловая группа (`… is disabled because this process group spans across nodes.`), неподдерживаемый размер группы;
- отсутствие полного NVLink при `world_size > 2` (`… is disabled because it's not supported on more than two PCIe-only GPUs.`);
- и только потом — собственно P2P-тест `can_p2p(rank, world_size)`, который поднимает два процесса и для каждой пары карт проверяет, что память, выделенная на одной, реально видна и изменяема с другой через CUDA IPC. При отказе — `… is disabled because your platform lacks GPU P2P capability or P2P test failed.`

Результат теста кешируется в файле `gpu_p2p_access_cache_for_<CUDA_VISIBLE_DEVICES>.json` внутри `SGLANG_CACHE_DIR`; имя намеренно включает набор видимых карт, а индексы в нем локальные. Если два процесса не согласились в оценке пары, пара помечается недоступной с предупреждением `Two processes do not agree on the P2P access status on X -> Y, treat as disabled.`

## Значения и формат

- Булев флаг без значения; «выключено» = не указывать (и это означает «проверка не выполняется»).
- На AMD (`is_hip()`) P2P-тест пропускается независимо от флага: между XGMI-связанными картами он считается доступным всегда.
- Первый запуск с флагом медленнее — тест реальный; последующие читают кеш.
- Кеш привязан к значению `CUDA_VISIBLE_DEVICES`: смена набора карт означает новый файл и новый прогон.

## Когда использовать

- Мультикарточный хост, где custom all-reduce включен, но результаты подозрительно неверны или процесс падает в коллективе: это ровно тот случай, ради которого проверка существует. Альтернатива — просто выключить custom all-reduce через `--disable-custom-all-reduce`.
- Виртуализация, контейнеры с ограниченным IPC, экзотические PCIe-топологии, где `nvidia-smi topo -m` показывает связь, а cudaIPC не работает.
- Не включать на обычном NVLink-узле: тест ничего не найдет, а старт удлинится.
- Не рассматривать как оптимизацию — флаг только диагностический: он либо подтвердит P2P, либо приведет к автоматическому отключению custom all-reduce.

## Влияние на производительность и память

- На forward не влияет напрямую. Влияет косвенно: если проверка провалится, custom all-reduce отключится, и коллективы пойдут через NCCL — обычно медленнее на маленьких сообщениях.
- Время старта: на первом запуске добавляются порождение двух процессов и попарный тест; на последующих читается JSON-кеш.
- Память: не затрагивается.

## Взаимодействие с другими аргументами

- `--disable-custom-all-reduce`: более прямой способ добиться того же результата, если P2P заведомо нет. Апстрим прямо предлагает его в тексте предупреждений, чтобы заглушить их.
- `--tp-size`: тест выполняется по парам рангов группы; стоимость растет с размером группы (батчированно).
- `--base-gpu-id` / `--gpu-id-step`: разреженная раскладка карт — самая частая причина, по которой полного NVLink нет и custom all-reduce отключается еще до P2P-теста.
- `--enable-mscclpp` / `--enable-torch-symm-mem`: альтернативные пути all-reduce, выбираемые в `_set_all_reduce_flags` рядом с этим механизмом.

## Типовые проблемы и диагностика

- `Custom allreduce is disabled because your platform lacks GPU P2P capability or P2P test failed. To silence this warning, specify disable_custom_all_reduce=True explicitly.` — проверка прошла и дала отрицательный результат. Это не ошибка конфигурации, а найденный факт.
- `Two processes do not agree on the P2P access status on X -> Y, treat as disabled.` — нестабильная пара; пара считается недоступной.
- `Custom allreduce is disabled because it's not supported on more than two PCIe-only GPUs.` — отсеялось раньше P2P-теста, по отсутствию полного NVLink.
- Тест выполняется каждый раз — проверьте, что `SGLANG_CACHE_DIR` доступен на запись и что `CUDA_VISIBLE_DEVICES` не меняется между запусками.
- Подозрение на неверные результаты без флага — включите его на один запуск: если после включения custom all-reduce отключился, предположение «P2P есть» было ложным.
- Что смотреть в логе: `enable_p2p_check=` в дампе `server_args=` и предупреждения выше на этапе `Init torch distributed begin.`

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --enable-p2p-check
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --disable-custom-all-reduce
```

## Источники

- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce_utils.py`
- `sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce.py`
- `sglang/python/sglang/srt/server_args.py`
