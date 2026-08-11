---
schema: 1
engine: sglang
primaryName: "--offload-group-size"
title: "--offload-group-size"
summary: Включает вторую схему оффлоада и задает размер группы слоев: из каждых `group_size` слоев выгружаются последние `--offload-num-in-group`. Требует поддержки со стороны модели — в checkout'е ее объявляет только семейство DeepSeek V2/V3.
group: exec.offload
related:
  - --offload-mode
  - --offload-num-in-group
  - --offload-prefetch-step
  - --cpu-offload-gb
  - --mem-fraction-static
  - --dp-size
  - --tp-size
---

# --offload-group-size

## Кратко

Это переключатель второй схемы оффлоада (`OffloaderV2`), а не просто параметр. Любое значение больше нуля включает ее; `-1` (значение по умолчанию) и `0` оставляют схему выключенной. В отличие от `--cpu-offload-gb`, где выгрузка задается объемом в гигабайтах и обслуживается синхронным копированием, здесь выгрузка задается структурно — «сколько слоев из каждой группы» — и обслуживается отдельным CUDA-потоком с предвыборкой.

Главное практическое ограничение: схема выгружает не слой целиком, а конкретный подмодуль, который модель обязана указать. Указание передается через `offloader_kwargs` в `make_layers`, и в текущем checkout'е его объявляет только `deepseek_v2.py` (эксперты `layer.mlp.experts`, параметры `w13_weight`/`w2_weight` и swizzled-масштабы для nvfp4). На любой другой модели включение схемы приводит к падению при построении слоев.

## Оригинальная справка

```text
Number of layers per group in offloading.
```

## Паспорт аргумента

- Флаги: `--offload-group-size`
- Группа: `exec.offload`
- Тип значения: int (число слоев в группе)
- Допустимые значения: `-1` или `0` — выключено; положительное целое — включает схему
- Значение по умолчанию: `-1`
- Эффективное значение: совпадает с заданным; автоподбора нет
- Где объявлен: `ServerArgs.offload_group_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; в апстрим-документации описан одной строкой, реальная семантика — только в коде
- Этап применения: создание `ModelRunner` (`create_offloader_from_server_args`) → построение слоев (`make_layers` → `OffloaderV2.wrap_modules`) → `post_init` после загрузки весов → каждый forward

## Что меняет в движке

### Кто выгружается

`OffloaderV2.wrap_modules` (`sglang/python/sglang/srt/utils/offloader.py`) обходит слои с индексом `module_index` и выбирает те, для которых

```python
module_index % group_size >= group_size - num_in_group
```

то есть **последние** `--offload-num-in-group` слоев каждой группы длины `group_size`. Для каждого выбранного слоя вызывается `submodule_accessor(module)` и `whitelist_param_names_creator(submodule)` — обе функции приходят из модели. Если модель их не передала, они равны `None`, и построение падает с `TypeError: 'NoneType' object is not callable`. Проверить поддержку своей модели можно поиском `offloader_kwargs` в ее файле в `sglang/python/sglang/srt/models/`.

### Как это исполняется

Каждый выбранный подмодуль оборачивается `_ModuleOffloader`, который:

- на `post_init` запускает предзагрузку первых `--offload-prefetch-step` групп;
- перед forward'ом ждет события завершения загрузки своих тензоров;
- после forward'а запускает загрузку группы `index + prefetch_step` и освобождает свои device-тензоры.

Копирование идет в **отдельном** CUDA-потоке, полученном как `get_stream("offload")`, с синхронизацией через `torch.cuda.Event`. В этом принципиальное отличие от `--cpu-offload-gb`: здесь загрузка следующих групп перекрывается с вычислением текущих.

Режимы `shm_cpu` и `sharded_gpu` дополнительно инициализируют `NaiveDistributed` с рандеву-точкой `/tmp/<SGLANG_RUN_ID>` по DP-рангам и требуют `--tp-size 1`.

## Значения и формат

- Целое. `-1` и `0` — выключено (условие включения строго `> 0`).
- Значение задает период, а не число выгружаемых слоев: при `--offload-group-size 4 --offload-num-in-group 1` выгружается каждый четвертый слой, то есть 25 % целевых подмодулей.
- `--offload-group-size 1` вместе с `--offload-num-in-group 1` выгружает все слои — предельный режим.
- Комбинация с ненулевым `--cpu-offload-gb` отвергается ассертом `V2 offload does not support cpu_offload_gb yet`.
- Проверок на осмысленность значения относительно числа слоев модели нет.

## Когда использовать

- На моделях семейства DeepSeek V2/V3, где веса экспертов доминируют по объему, а на каждый токен активируется лишь часть из них: выгрузка экспертов с предвыборкой — то, ради чего схема написана.
- В тестовом контуре с `--offload-mode meta`, чтобы измерить потолок экономии VRAM без реального копирования (генерация при этом бессмысленна).
- Не включать на моделях вне списка поддержки: падение произойдет на построении слоев, до первого запроса, но диагностическое сообщение (`TypeError`) о причине не скажет ничего.
- Не использовать вместо `--cpu-offload-gb` как «улучшенную версию»: у них разные области применимости, и вторая схема работает не везде.

## Влияние на производительность и память

- VRAM: экономия равна `(доля выгруженных слоев) × (размер целевого подмодуля)` минус то, что удерживается предвыборкой (`--offload-prefetch-step` групп одновременно резидентны).
- RAM хоста: в режиме `cpu` — закрепленная память под все выгруженные параметры; в `shm_cpu` — одна общая копия на все DP-ранги; в `sharded_gpu` память остается на GPU, распределенная по рангам.
- Время старта: `post_init` выполняет распределение/перенос параметров и первую предзагрузку; в `sharded_gpu` добавляется scatter между рангами.
- Latency: копирование перекрывается с вычислением, поэтому при достаточной глубине предвыборки накладные расходы могут быть близки к нулю — до тех пор, пока полосы PCIe хватает на темп потребления групп.
- Throughput: чем больше `group_size` при фиксированном `num_in_group`, тем меньше выгружено и тем меньше трафика.
- CUDA graph: при захвате графа `_ModuleOffloader.start_onload` уходит в синхронную ветку (`torch.cuda.is_current_stream_capturing`), то есть перекрытия внутри графа нет.

## Взаимодействие с другими аргументами

- `--offload-num-in-group`: вторая половина той же формулы; вместе задают долю выгруженного.
- `--offload-mode`: куда именно выгружать (`cpu`, `shm_cpu`, `sharded_gpu`, `meta`).
- `--offload-prefetch-step`: глубина предвыборки, то есть баланс между перекрытием и резидентной VRAM.
- `--cpu-offload-gb`: взаимно исключающая схема.
- `--tp-size`: режимы `shm_cpu` и `sharded_gpu` требуют `1`.
- `--dp-size`: в `shm_cpu`/`sharded_gpu` ранги DP образуют группу, между которой распределяются или разделяются веса.
- `--mem-fraction-static`: освобожденная VRAM автоматически уходит в KV-пул, поскольку тот считается от свободной памяти после загрузки весов.

## Типовые проблемы и диагностика

- `TypeError: 'NoneType' object is not callable` при построении слоев — модель не поддерживает вторую схему оффлоада (не передает `offloader_kwargs`).
- `AssertionError: V2 offload does not support cpu_offload_gb yet` — заданы обе схемы.
- `AssertionError: not yet support tp_size!=1` — режим `shm_cpu`/`sharded_gpu` при `--tp-size` больше 1.
- `KeyError` по имени режима — опечатка в `--offload-mode` (у него нет объявленных `choices`).
- Включили, а VRAM не освободилась — при `--offload-prefetch-step`, сравнимом с числом групп, резидентными оказываются почти все выгруженные подмодули.
- Что смотреть в логе: строки `[offloader] offload module_index=… submodule=… params=[…] memory_allocated=…` — по одной на каждый выгруженный слой; их количество прямо подтверждает, что формула группы дала ожидаемый результат.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V2-Lite --offload-group-size 4 --offload-num-in-group 1 --offload-prefetch-step 1
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V2-Lite --offload-group-size 2 --offload-num-in-group 1 --offload-mode cpu --offload-prefetch-step 2
```

## Источники

- `sglang/python/sglang/srt/utils/offloader.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/test/registered/npu/basic_function/offloading/test_npu_offload_modes.py`
