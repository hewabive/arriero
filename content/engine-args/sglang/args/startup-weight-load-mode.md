---
schema: 1
engine: sglang
primaryName: "--startup-weight-load-mode"
title: "--startup-weight-load-mode"
summary: Режим overlap совмещает чтение checkpoint-файлов с захватом CUDA graph на старте — графы пишутся на модель с весами-заглушками, настоящие веса коммитятся после. Жесткий allowlist — CUDA, safetensors, TP1/TP2, только Llama/Qwen2/Qwen3 без квантизации; вне его старт падает с точной причиной.
group: model
related:
  - --load-format
  - --cuda-graph-config
  - --enable-torch-compile
  - --speculative-algorithm
  - --tp-size
  - --dtype
  - --quantization
  - --enable-lora
  - --cpu-offload-gb
  - --weight-loader-prefetch-num-threads
---

# --startup-weight-load-mode

## Кратко

Обычный старт последователен: прочитать веса с диска → выделить KV-пул → захватить CUDA graphs. Две самые долгие фазы — дисковый ввод-вывод и захват графов — при этом не пересекаются, хотя нагружают разные ресурсы. `--startup-weight-load-mode overlap` их совмещает: модель конструируется сразу с весами-заглушками (каждый floating-point-параметр равен константе `1e-3`), захват графов идет на этих заглушках, а параллельно фоновые потоки прогревают checkpoint-файлы в page cache; после захвата настоящие веса коммитятся в те же тензорные хранилища — адреса, формы и страйды обязаны не измениться, иначе записанные графы указывали бы в никуда, и это проверяется явно. Значение по умолчанию `serial` сохраняет прежний порядок.

## Оригинальная справка

```text
Control startup weight loading relative to CUDA graph capture. 'serial' preserves the existing startup order; 'overlap' stages checkpoint files while CUDA graphs are captured and commits the real weights afterward.
```

## Паспорт аргумента

- Флаги: `--startup-weight-load-mode`
- Группа: `model`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `serial`, `overlap`
- Значение по умолчанию: `serial`
- Эффективное значение: не переписывается в `__post_init__`; читается через свойство `ServerArgs.is_startup_weight_load_overlap`, а применимость проверяется позже, на этапе загрузки модели
- Где объявлен: `ServerArgs.startup_weight_load_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; сам механизм — начальный rollout с узким allowlist'ом конфигураций
- Этап применения: только старт сервера — загрузка модели → префетч → захват CUDA graph → коммит весов; на работу после старта не влияет

## Что меняет в движке

Всю логику несет `StartupWeightLoadManager` (`sglang/python/sglang/srt/model_executor/model_runner_components/startup_weight_load.py`); порядок задает `Scheduler.init_model_worker` (`sglang/python/sglang/srt/managers/scheduler.py`):

1. **prepare** — вместо `loader.load_model` модель инициализируется capture-safe: структура настоящая, все floating-point-параметры залиты сентинелом `1e-3`. В логе: `Prepared capture-safe model in N s`.
2. **start_prefetch** — сразу после создания воркера запускаются фоновые потоки (`--weight-loader-prefetch-num-threads`), которые читают safetensors-файлы, прогревая page cache. В логе: `Started checkpoint prefetching N s after capture-safe model prep`.
3. Параллельно идут обычные шаги: выделение KV-пула, инициализация attention backend'ов, **захват CUDA graphs** — все на модели-заглушке.
4. **finalize** — после захвата настоящие веса коммитятся в существующие тензоры. Две страховки: манифест хранилищ (адрес/форма/страйд/тип каждого параметра и буфера) обязан совпасть до и после — иначе `RuntimeError: Startup weight commit changed graph-visible tensor storage: …`; и ни один floating-point-параметр не должен остаться равным сентинелу целиком — иначе `RuntimeError: Startup weight commit did not replace capture-safe dummy values: …`. Итог в логе: `Load weight end. Committed real weights after CUDA graph capture in N s (capture overlap window M s, startup overlap total T s)`.

Сбой префетча не фатален: загрузка деградирует к обычному чтению с предупреждением `Checkpoint prefetch was incomplete because …` — выигрыш теряется, корректность нет.

### Allowlist

`_get_unsupported_reason` отклоняет режим `overlap` с `ValueError: --startup-weight-load-mode=overlap is not supported: <причина>`, если нарушено любое из условий: платформа CUDA (`device=cuda`; MLX-путь отвергает отдельно); CUDA graphs включены (иначе перекрывать нечего) и prefill-графы не `tc_piecewise`; загрузчик — `DefaultModelLoader`, `--load-format` `auto` или `safetensors`; без draft-воркеров и `--speculative-algorithm`; `--tp-size` 1 или 2; без CP/DCP/PP/DP/EP; без `--cpu-offload-gb`, `--offload-group-size`, `--enable-memory-saver`, `--enable-weights-cpu-backup`; без LoRA; mmap safetensors включен и без сброса page cache после загрузки; без `--custom-weight-loader` и `--enable-torch-compile`. Модель: dtype fp16/bf16, без квантизации и ModelOpt, не мультимодальная, генеративная, ровно одна архитектура из `LlamaForCausalLM` / `Qwen2ForCausalLM` / `Qwen3ForCausalLM`, и разрешаться она должна в нативную реализацию SGLang.

## Значения и формат

- `serial` — прежний порядок: веса читаются полностью до захвата графов. Всегда безопасно.
- `overlap` — совмещение; при любом неподдержанном условии старт **падает**, а не откатывается к `serial` молча.

## Когда использовать

- Частые рестарты dense-модели Llama/Qwen на NVMe/сетевом хранилище, где чтение чекпойнта и захват графов сопоставимы по времени: выигрыш — почти все окно захвата.
- Холодный page cache (первый старт после перезагрузки хоста): префетч греет кеш параллельно захвату, и коммит читает уже из памяти.
- Не задавать в конфигурациях вне allowlist'а (MoE, квантизация, спекуляция, TP>2, мультимодальность) — это гарантированный отказ старта, а не замедление.
- Мало смысла при горячем page cache и маленькой модели: коммит и так быстрый, окно перекрытия ничего не прячет.

## Влияние на производительность и память

- Время старта — единственная цель: захват CUDA graph и дисковый ввод-вывод идут одновременно; сколько удалось спрятать, лог показывает явно (`capture overlap window M s`).
- RAM хоста: префетч заполняет page cache объемом до размера чекпойнта — это reclaimable-память, но на хосте с жестким учетом (профиль SGLang-KT в arriero, `docs/RESOURCE_MANAGEMENT.md`) всплеск стоит учитывать.
- VRAM: не меняется — тензоры те же, коммит переписывает содержимое по месту.
- После старта режим ни на что не влияет: скорость, точность и память сервинга идентичны `serial`.

## Взаимодействие с другими аргументами

- `--cuda-graph-config`: выключенные графы делают `overlap` невозможным (перекрывать нечего); `tc_piecewise` для prefill несовместим.
- `--load-format`: только `auto`/`safetensors`; форматы вне safetensors не поддержаны.
- `--weight-loader-prefetch-num-threads`: ширина префетча — число потоков, читающих checkpoint-файлы в фоне.
- `--tp-size`: 1 или 2; больше — отказ.
- `--speculative-algorithm`, `--enable-lora`, `--quantization`, `--enable-torch-compile`, `--cpu-offload-gb`, `--enable-memory-saver`, `--custom-weight-loader`: каждый из них — самостоятельная причина отказа; список причин движок называет буквально.
- `--dtype`: только fp16/bf16.

## Типовые проблемы и диагностика

- `ValueError: --startup-weight-load-mode=overlap is not supported: model architecture is not in the startup-overlap allowlist` — модель не Llama/Qwen2/Qwen3 dense; текст после двоеточия всегда называет конкретное нарушенное условие (`speculative decoding is not supported`, `only TP1 and TP2 are supported`, `quantization is not supported`, …).
- `RuntimeError: Startup weight commit changed graph-visible tensor storage: …` — коммит пересоздал тензор вместо записи по месту; это баг конфигурации/модели, сервер с испорченными графами не поднимется — так и задумано.
- `Checkpoint prefetch was incomplete because …; falling back to normal weight loading` в логе — префетч не справился (диск, права); старт продолжается медленнее, но корректно.
- Как убедиться, что режим сработал: тройка строк `Prepared capture-safe model …` → `Started checkpoint prefetching …` → `Load weight end. Committed real weights after CUDA graph capture …` и само поле в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --startup-weight-load-mode overlap
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --startup-weight-load-mode overlap --tp-size 2 --weight-loader-prefetch-num-threads 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/startup_weight_load.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- upstream PR: sgl-project/sglang#32017 ([Model Loading] Overlap checkpoint staging with CUDA graph capture during startup)
- arriero: `docs/RESOURCE_MANAGEMENT.md`
