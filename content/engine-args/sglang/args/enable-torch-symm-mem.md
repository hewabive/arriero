---
schema: 1
engine: sglang
primaryName: "--enable-torch-symm-mem"
title: "--enable-torch-symm-mem"
summary: Добавляет в цепочку выбора all-reduce путь через symmetric memory PyTorch (`torch.ops.symm_mem.multimem_all_reduce_` / `two_shot_all_reduce_`). Работает только на bf16-тензорах, только на SM90/SM100 и только при доступном NVLink-multicast; во всех остальных случаях коммуникатор тихо остается выключенным.
group: exec.comm
related:
  - --enable-symm-mem
  - --enable-mscclpp
  - --disable-custom-all-reduce
  - --enable-scattered-sconv
  - --tp-size
  - --dtype
  - --enable-deterministic-inference
  - --enable-nccl-nvls
---

# --enable-torch-symm-mem

## Кратко

Флаг регистрирует у каждой TP-группы `TorchSymmMemCommunicator` — тонкую обертку над symmetric-memory-коллективами PyTorch. Ядро выбирается по топологии: `multimem_all_reduce_` там, где NVLink-multicast покрывает всю группу, иначе `two_shot_all_reduce_`. Ограничений много и все они проверяются молча: только bf16, только compute capability 9 или 10, только определенные world size, только тензоры меньше 64–128 МиБ. Если хоть одно не выполнено, коммуникатор остается `disabled`, а редукции идут обычным путем — сервер стартует, работает и ничем не сигналит, кроме одной строки warning на старте.

## Оригинальная справка

```text
Enable using torch symm mem for all-reduce kernel and fall back to NCCL. Only supports CUDA device SM90 and above. SM90 supports world size 4, 6, 8. SM100 supports world size 6, 8.
```

## Паспорт аргумента

- Флаги: `--enable-torch-symm-mem`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: `--enable-deterministic-inference` при `tp_size > 1` на CUDA принудительно ставит `False` с явным обоснованием в коде — порог `should_torch_symm_mem_allreduce` зависит от размера тензора, значит выбор пути редукции зависел бы от числа токенов, что ломает воспроизводимость
- Где объявлен: `ServerArgs.enable_torch_symm_mem`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (сброс в детерминированном режиме) → `_set_all_reduce_flags` → конструктор `GroupCoordinator` (создание `TorchSymmMemCommunicator` и rendezvous буфера) → каждый forward

## Что меняет в движке

`_set_all_reduce_flags` вызывает `set_torch_symm_mem_all_reduce(...)`, значение попадает в `_ENABLE_TORCH_SYMM_MEM_ALL_REDUCE` и читается при создании групп. Как и у custom all-reduce, attention-TP-группа при DP-attention создается с явным `use_torch_symm_mem_allreduce=False`, то есть путь живет только в основной TP-группе.

### Что проверяется при создании коммуникатора

`TorchSymmMemCommunicator.__init__` (`distributed/device_communicators/torch_symm_mem.py`) выключает себя и молча возвращается, если:

- недоступен `torch.distributed._symmetric_memory` или устройство не CUDA;
- compute capability major нет в таблице `TORCH_SYMM_MEM_ALL_REDUCE_MAX_SIZES` — там только `9` (Hopper) и `10` (Blackwell SM100). Ada (8.9) и SM120 отбраковываются с warning `TorchSymmMemCommunicator: Device capability 8 not supported, communicator is not available.`;
- world size группы нет в таблице для этой архитектуры — в checkout'е это `2, 4, 6, 8` для обеих архитектур, с максимальным размером 64 МиБ для 2 и 4 и 128 МиБ для 6 и 8. **Это шире, чем написано в справке:** текст help говорит про «SM90: 4, 6, 8; SM100: 6, 8», код принимает и world size 2. Расхождение проверяется чтением `all_reduce_utils.py`;
- `torch_symm_mem.rendezvous(...)` вернул `multicast_ptr == 0` — тогда предупреждение `torch symmetric memory multicast operations are not supported.` и коммуникатор выключается. Это и есть проверка на реальный NVLink-multicast (NVSwitch/NVLS): без него путь недоступен.

Только если всё сошлось, выделяется симметричный буфер размером `max_size` и `disabled` становится `False`.

### Что заменяет в пути all-reduce

`_resolve_outplace_all_reduce_method` пробует пути по порядку `ca` → `qr` → `pymscclpp` → `torch_symm_mem` → pynccl. То есть torch symm mem подхватывает только то, что не забрали custom all-reduce и mscclpp: на CUDA-хосте с включенным custom AR это тензоры **больше** его порога (8–16 МиБ), но меньше 64/128 МиБ — то есть крупные prefill-редукции. Чтобы отдать ему и мелкие, нужен `--disable-custom-all-reduce`.

Приемка конкретного тензора (`should_torch_symm_mem_allreduce`): тип строго `torch.bfloat16`, устройство совпадает, размер в байтах кратен 4 и строго меньше `max_size`. Модель в fp16 или fp8-активациях этот путь не увидит вообще.

Само ядро выбирается в `all_reduce`: `multimem_all_reduce_`, если world size есть в `_WORLD_SIZES_MULTIMEM` (`{9: [4, 6, 8], 10: [4, 6, 8]}`), иначе `two_shot_all_reduce_`. При world size 2 это всегда two-shot.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- На одной карте инертен: коммуникатор создается только при `world_size > 1`.
- Порог размера не настраивается флагом. Единственное место, где он поднимается, — `SGLANG_OPT_USE_INKLING_CUSTOM_AR` для моделей Inkling (до 256 МиБ, а с `--enable-scattered-sconv` до 512 МиБ).
- Никаких «мягких» значений нет: либо путь доступен целиком, либо его нет.

## Когда использовать

- Hopper или Blackwell с NVSwitch, bf16-модель, `--tp-size` 4/6/8, и вы уже видите, что крупные редукции prefill упираются в NCCL. Это единственный сценарий, где флаг честно окупается.
- Если вы хотите разогнать **decode** (мелкие тензоры), одного этого флага мало: их заберет custom all-reduce. Либо `--disable-custom-all-reduce`, либо смотрите в сторону `--enable-symm-mem`.
- Не включайте на fp16-модели: `should_torch_symm_mem_allreduce` отбракует каждый тензор, и путь не выполнится ни разу.
- Не включайте вместе с `--enable-symm-mem`: pynccl-ветка симметричной памяти NCCL стоит раньше в `all_reduce` и заберет всё.
- Не включайте в детерминированном режиме — движок все равно сбросит флаг.

## Влияние на производительность и память

- **VRAM.** Симметричный буфер `max_size` на ранг: 64 МиБ при world size 2/4 и 128 МиБ при 6/8 (для моделей Inkling с включенным `SGLANG_OPT_USE_INKLING_CUSTOM_AR` — до 256/512 МиБ). Плюс временный `out` под каждый вызов (аллокация из общего кэша torch).
- **Latency.** Выигрыш на редукциях того диапазона размеров, который иначе уходил бы в NCCL ring. На тензорах вне диапазона — нулевой.
- **Throughput.** Заметен на prefill с большим `--chunked-prefill-size`, где редукции как раз крупные.
- **Время старта.** Плюс rendezvous буфера по всей группе; на неподходящей топологии rendezvous отработает и вернет нулевой multicast-указатель, буфер будет освобожден.
- **Хост.** Не меняется.

## Взаимодействие с другими аргументами

- `--enable-symm-mem`: перекрывает этот путь целиком на одноузловой конфигурации. Выбирайте один из двух.
- `--disable-custom-all-reduce`: снимает конкурента на мелких тензорах и делает torch symm mem основным путем для bf16.
- `--enable-mscclpp`: проверяется раньше; при world size 8/16/32 подходящие размеры уйдут в mscclpp.
- `--enable-scattered-sconv`: у моделей Inkling reduce-scatter и all-gather по скрытой размерности используют именно этот коммуникатор (`_symm_mem_comm` в `models/inkling_common/kernels/comm.py`); без него они падают обратно на `reduce_scatter_tensor`/`all_gather` NCCL.
- `--dtype`: путь существует только для bf16.
- `--tp-size`: определяет и допустимость world size, и выбор multimem против two-shot.
- `--enable-deterministic-inference`: принудительно выключает флаг.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, ускорения нет. **Причина №1:** коммуникатор выключился на старте. **Проверка:** предупреждения `TorchSymmMemCommunicator: Device capability … not supported`, `World size … not supported`, `torch symmetric memory multicast operations are not supported.` **Причина №2:** все редукции забирает custom all-reduce или NCCL symm mem.
- **Симптом:** ничего не происходит на fp16-модели. **Причина:** буфер и ядро работают только с bf16.
- **Симптом:** OOM на карте после включения флага при уже впритык подобранном `--mem-fraction-static`. **Причина:** 64–128 МиБ симметричного буфера на ранг.
- **Симптом:** в детерминированном режиме флаг «не применился». **Причина:** это штатный сброс, в логе есть строка про отключение custom и symmetric-memory all-reduce при TP > 1.
- **Что смотреть:** итоговый дамп `server_args=` при старте и перечисленные выше предупреждения коммуникатора — других сигналов о том, что путь активен, движок не печатает.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --tensor-parallel-size 8 --enable-torch-symm-mem
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --tensor-parallel-size 8 --enable-torch-symm-mem --disable-custom-all-reduce
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/device_communicators/torch_symm_mem.py`
- `sglang/python/sglang/srt/distributed/device_communicators/all_reduce_utils.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/models/inkling_common/kernels/comm.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
