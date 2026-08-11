---
schema: 1
engine: sglang
primaryName: "--enable-nccl-nvls"
title: "--enable-nccl-nvls"
summary: Единственная функция флага — выставить `NCCL_NVLS_ENABLE=1`. Без него SGLang принудительно пишет туда `0`, то есть NVLink SHARP выключен по умолчанию, даже если железо его поддерживает.
group: exec.comm
related:
  - --enable-symm-mem
  - --enable-torch-symm-mem
  - --enable-mscclpp
  - --disable-custom-all-reduce
  - --tp-size
  - --nnodes
  - --chunked-prefill-size
---

# --enable-nccl-nvls

## Кратко

NVLS (NVLink SHARP) — редукция «в сети»: NVSwitch сам складывает данные по пути между картами, вместо того чтобы гонять их кольцом. NCCL умеет включать этот алгоритм сам, когда железо и версия позволяют, но SGLang этого не хочет: в `_set_envs_and_config` он безусловно записывает `NCCL_NVLS_ENABLE=0`, если переменной не было в окружении. `--enable-nccl-nvls` — это переключатель того самого значения на `1`. Никакой другой логики за флагом нет: он не создает коммуникаторов, не меняет выбор пути в `GroupCoordinator` и не проверяет топологию. Всё дальнейшее решает NCCL.

## Оригинальная справка

```text
Enable NCCL NVLS for prefill heavy requests when available.
```

## Паспорт аргумента

- Флаги: `--enable-nccl-nvls`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: само поле не переписывается, но результат — да: `--enable-symm-mem` включает NVLS независимо от этого флага, потому что переменная считается как `int(enable_nccl_nvls or enable_symm_mem)`
- Где объявлен: `ServerArgs.enable_nccl_nvls`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_set_envs_and_config` (`sglang/python/sglang/srt/entrypoints/engine.py`) до запуска процессов scheduler'а → инициализация NCCL-коммуникаторов

## Что меняет в движке

Весь эффект — этот блок в `_set_envs_and_config`:

```python
if ("NCCL_NVLS_ENABLE" not in os.environ
        or server_args.enable_nccl_nvls
        or server_args.enable_symm_mem):
    os.environ["NCCL_NVLS_ENABLE"] = str(int(server_args.enable_nccl_nvls or server_args.enable_symm_mem))
```

Из него следуют три неочевидных вывода:

1. **По умолчанию NVLS выключен принудительно.** Не «оставлен на усмотрение NCCL», а именно записан нулем. Это отличается от поведения голого NCCL и объясняет, почему на NVSwitch-хосте вы можете не увидеть NVLS-алгоритмов в `NCCL_DEBUG=INFO`.
2. **Внешне заданное значение уважается только пока флаги выключены.** Если вы экспортировали `NCCL_NVLS_ENABLE=1` в окружении инстанса и не задали ни `--enable-nccl-nvls`, ни `--enable-symm-mem`, условие ложно и ваше значение сохранится. Как только любой из флагов включен, переменная перезаписывается расчетным значением.
3. **`--enable-symm-mem` делает флаг избыточным.**

Рядом в том же блоке живет `NCCL_CUMEM_ENABLE`, и он считается только по `enable_symm_mem`. То есть `--enable-nccl-nvls` в одиночку включает NVLS, но оставляет `NCCL_CUMEM_ENABLE=0` (если переменной не было в окружении). Совместимость этой пары зависит от версии NCCL; проверять ее надо на своей сборке через `NCCL_DEBUG=INFO`, а не по этому документу.

### Что NVLS заменяет в пути all-reduce

Ничего в коде SGLang. Путь `pynccl`/`torch.distributed.all_reduce` остается тем же — меняется алгоритм внутри NCCL: вместо ring/tree используется multicast-редукция на NVSwitch. Практически NVLS выигрывает на **крупных** сообщениях, отсюда и формулировка help про «prefill heavy requests»: на decode тензоры мелкие и их и так забирает custom all-reduce.

### Требования к топологии

NVLink SHARP реализован в NVSwitch, начиная с третьего поколения (HGX H100/H200, GH200, GB200 NVL). На хосте с картами, соединенными напрямую NVLink-мостами без NVSwitch, и тем более на PCIe-хосте NVLS недоступен. Отказ мягкий: NCCL просто не выберет NVLS-алгоритм, сервер стартует и работает через ring. Стартовой ошибки от этого флага не бывает — он ничего не проверяет.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет. Чтобы явно выключить NVLS, ничего задавать не надо — это и есть поведение по умолчанию.
- Переменная выставляется в окружении процесса до fork'а scheduler'ов, поэтому распространяется на все ранги одного узла. На многоузловом запуске флаг надо задавать в командной строке **каждого** узла.

## Когда использовать

- Хост с NVSwitch, `--tp-size` 4 и больше, нагрузка с длинным prefill (большой `--chunked-prefill-size`, длинные документы) — это ровно тот профиль, под который флаг описан.
- Когда вы уже включили `--enable-symm-mem` — задавать не нужно, он и так включен.
- Не включайте на PCIe-хосте или паре карт с NVLink-мостом: NVLS там не появится, а лишний флаг в конфигурации будет вводить в заблуждение при разборе инцидентов.
- Не ожидайте выигрыша на decode-ориентированной нагрузке: там побеждают мелкие ядра, а не in-network редукция.

## Влияние на производительность и память

- **VRAM.** NCCL под NVLS выделяет собственные multicast-буферы; размер определяется NCCL и его настройками (`NCCL_BUFFSIZE` и родственные), не SGLang. Порядок — десятки МиБ на ранг.
- **Latency и throughput.** Выигрыш на крупных редукциях prefill; на decode практически нулевой.
- **Время старта.** Плюс инициализация multicast-объектов в NCCL; на неподдерживающем железе NCCL просто не пойдет по этой ветке.
- **Хост.** Не меняется.

## Взаимодействие с другими аргументами

- `--enable-symm-mem`: включает NVLS сам; отдельный флаг не нужен и ничего не добавляет.
- `--enable-mscclpp`: набор алгоритмов MSCCL++ включает собственные `nvls`-варианты, но они управляются `--enable-symm-mem`, а не этим флагом.
- `--disable-custom-all-reduce`: отдает NCCL и мелкие редукции тоже — вместе с NVLS это осмысленная пара, если вы хотите весь путь на NCCL.
- `--tp-size`, `--nnodes`: NVLS работает внутри NVLink-домена; на межузловых коллективах его не будет (кроме NVL72-домена, где NVLink проходит через узлы).
- `--chunked-prefill-size`: определяет размер редукций на prefill, то есть ровно тот класс сообщений, где NVLS выигрывает.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, разницы нет. **Причина:** нет NVSwitch с поддержкой NVLink SHARP, либо NCCL не выбрал алгоритм. **Проверка:** запустить с `NCCL_DEBUG=INFO` и искать строки NCCL про NVLS/algorithm в логе инстанса.
- **Симптом:** экспортированный `NCCL_NVLS_ENABLE=1` «не работает» без флага. **Причина:** это как раз работает — перезапись происходит только при включенных флагах; если NVLS все равно не появился, дело в железе или версии NCCL.
- **Симптом:** NVLS «сам включился», хотя флаг не задан. **Причина:** задан `--enable-symm-mem`.
- **Симптом:** ошибки NCCL вида «NVLS not supported» / падение при инициализации. **Причина:** несовместимая версия NCCL или драйвера. **Решение:** убрать флаг; SGLang в этом случае ничего не откатывает сам.
- **Что смотреть:** итоговый дамп `server_args=` при старте подтверждает, что флаг принят; фактическое включение видно только в логах NCCL.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --enable-nccl-nvls --chunked-prefill-size 16384
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --enable-nccl-nvls --disable-custom-all-reduce
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/distributed/device_communicators/pymscclpp.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
