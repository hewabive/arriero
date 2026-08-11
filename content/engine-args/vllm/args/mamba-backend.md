---
schema: 1
engine: vllm
primaryName: "--mamba-backend"
title: "--mamba-backend"
summary: Выбирает реализацию selective state update для слоёв Mamba1/Mamba2 — Triton (по умолчанию), FlashInfer или CPU. Действует только на decode-шаг SSM и только у моделей с этими слоями.
group: MambaConfig
related:
  - --mamba-ssu-algorithm
  - --enable-mamba-cache-stochastic-rounding
  - --mamba-cache-philox-rounds
  - --mamba-ssm-cache-dtype
  - --mamba-cache-mode
  - --mamba-block-size
  - --use-replayssm
  - --gdn-prefill-backend
---

# --mamba-backend

## Кратко

У гибридных SSM-моделей decode-шаг проходит через `selective_state_update` — обновление скрытого состояния Mamba. vLLM держит три реализации этой операции и выбирает между ними этим аргументом: Triton-ядро (значение по умолчанию), FlashInfer и компилированное C++-ядро для CPU.

Аргумент узкий по области действия: он не влияет ни на prefill (там работает chunked scan), ни на другие типы линейных слоёв (GDN, short-conv, linear attention), ни на модели без Mamba1/Mamba2-групп — инициализация backend'а просто пропускается.

## Оригинальная справка

```text
Mamba SSU backend to use.
```

## Паспорт аргумента

- Флаги: `--mamba-backend`
- Группа argparse: `MambaConfig`
- Тип значения: строка — имя элемента `MambaBackendEnum`, регистр не важен. В extract тип помечен как `json`, но это артефакт извлекателя: `MambaBackendEnum` объявлен в `vllm/config/mamba.py` и попадает в список известных config-классов. Argparse получает обычный `type=str`
- Допустимые значения: `triton`, `flashinfer`, `cpu`. В `--help` перечня нет (`choices` пуст), но неверное значение печатает список само: `ValueError: Unknown Mamba SSU backend: 'X'. Valid options are: TRITON, FLASHINFER, CPU`
- Значение по умолчанию: `MambaBackendEnum.TRITON`
- Эффективное значение: на CPU-платформе `triton` автоматически подменяется на `cpu` (`CPU platform detected: overriding Mamba SSU backend from 'triton' to 'cpu'.`), потому что Triton JIT там нестабилен или отсутствует. Явно заданное не-`triton` значение эта подмена не трогает
- Где объявлен: `vllm/config/mamba.py:MambaConfig.backend`
- Этап применения: разбор CLI → `create_engine_config` (строка → enum) → инициализация модели в worker'е (`initialize_mamba_ssu_backend`) → каждый decode-шаг Mamba-слоя

## Что меняет в движке

`initialize_mamba_ssu_backend(mamba_config, kv_cache_config)` (`vllm/model_executor/layers/mamba/ops/ssu_dispatch.py`) вызывается из model runner'а после построения KV-cache. Первым делом он проверяет, есть ли среди групп KV-cache хоть одна `MambaSpec` типа `MAMBA1` или `MAMBA2`; если нет — выходит, и аргумент не имеет никакого эффекта.

Дальше выбирается класс из `_BACKEND_REGISTRY` и логируется `Using <name> Mamba SSU backend.` Глобальная функция `selective_state_update(...)` делегирует ему каждый вызов.

Реализации:

- **`triton`** — `vllm/model_executor/layers/mamba/ops/mamba_ssm.py`, ядро на Triton. Единственный backend, у которого стохастическое округление сделано инструкцией `cvt.rs.f16x2.f32` (то есть требует SM 10.x), и единственный, поддерживаемый `--use-replayssm`.
- **`flashinfer`** — обёртка над `flashinfer.mamba.selective_state_update`. Импорт ленивый: отсутствие библиотеки даёт `ImportError: FlashInfer is required for the flashinfer Mamba SSU backend. Please install flashinfer (>= 0.6.4)`. Только этот backend понимает `--mamba-ssu-algorithm`; при инициализации он печатает `Using FlashInfer Mamba SSU algorithm: <алгоритм>`.
- **`cpu`** — `torch.ops._C.selective_state_update_cpu`, векторизованное C++-ядро (VSX на ppc64le, AVX2 на x86) с OpenMP-параллелизмом по головам; при отсутствии скомпилированной операции откатывается на чистый PyTorch. Логирует `CPUSSUBackend: using compiled C++ selective_state_update kernel.`

Backend хранится в модуле как глобальный синглтон; повторная инициализация тем же классом — no-op.

## Значения и формат

- Одно из трёх имён, регистр не важен: `flashinfer`, `FlashInfer`, `FLASHINFER` эквивалентны (`MambaBackendEnum[value.upper()]`). Замены дефисов на подчёркивания, в отличие от `--moe-backend`, здесь нет — но и имён с разделителями тоже нет.
- Пустая строка и `None` не поддерживаются: поле не помечено `optional`.
- `cpu` на GPU-хосте разбор пройдёт, а вычисления уйдут на C++-ядро CPU — это не то, чего вы хотите на CUDA-инстансе.
- Аргумент не меняет ни формат хранения состояния SSM (`--mamba-ssm-cache-dtype`), ни размер блока (`--mamba-block-size`), ни режим кеша (`--mamba-cache-mode`).

## Когда использовать

- **`flashinfer` для замера на поддерживаемой карте.** Единственный способ получить доступ к алгоритмам selective state update FlashInfer (`--mamba-ssu-algorithm`) и к их автоподбору.
- **`flashinfer`, если нужно стохастическое округление не на data center Blackwell.** У Triton-пути оно упирается в PTX-инструкцию `cvt.rs`, доступную только на SM 10.x; сообщение об ошибке само предлагает перейти на FlashInfer.
- **`cpu` только на CPU-инстансе** — и там он выбирается сам, задавать вручную не нужно.
- **Оставьте `triton`, если нет конкретной причины.** Это дефолт апстрима, он не требует внешних библиотек и он же единственный совместимый с `--use-replayssm`.
- **Не задавайте на модели без Mamba1/Mamba2.** Для GDN-слоёв есть свой `--gdn-prefill-backend`, этот аргумент их не касается.

## Влияние на производительность и память

- **Latency decode.** Основная точка приложения: `selective_state_update` вызывается на каждом decode-шаге каждого SSM-слоя. Разница между Triton- и FlashInfer-ядрами измеряется прямым замером на вашей карте и размерах состояния.
- **VRAM.** Постоянного расхода не добавляет: состояние живёт в mamba-группе KV-cache, размер которой задают другие аргументы. Рабочие буферы ядер различаются, но на фоне состояния незначительны.
- **Время старта.** Triton-ядро компилируется JIT при первом вызове; FlashInfer тянет свой JIT-стек. На CPU-пути JIT нет.
- **Численность.** Ядра дают близкие, но не побитово идентичные результаты; при переключении backend'а ожидайте расхождений в последних битах состояния, которые на длинных последовательностях накапливаются.

## Взаимодействие с другими аргументами

- `--mamba-ssu-algorithm`: работает только с `flashinfer`. С `triton` или `cpu` старт падает: `Mamba SSU algorithm selection is only supported with the FlashInfer backend. Please set --mamba-backend flashinfer, or omit --mamba-ssu-algorithm.`
- `--enable-mamba-cache-stochastic-rounding`: требует CUDA. Дополнительно, при `triton` требует compute capability семейства 10.0; на `flashinfer` этого ограничения нет.
- `--mamba-cache-philox-rounds`: передаётся в оба GPU-ядра, но по-разному: Triton получает значение как есть (`0` = дефолт Triton), FlashInfer подставляет `10` вместо нуля.
- `--mamba-ssm-cache-dtype`: стохастическое округление требует `float16`; сам выбор backend'а формат состояния не меняет.
- `--use-replayssm`: жёстко требует Triton — `ValueError: --use-replayssm requires --mamba-backend triton`.
- `--mamba-cache-mode`, `--mamba-block-size`: определяют раскладку и режим кеша состояний; на выбор backend'а не влияют.
- `--gdn-prefill-backend`: отдельная ручка для gated delta net; не пересекается.

## Типовые проблемы и диагностика

- **Симптом:** `ImportError: FlashInfer is required for the flashinfer Mamba SSU backend. Please install flashinfer (>= 0.6.4)`. **Причина:** библиотека не установлена в окружении инстанса. **Лечение:** вернуть `triton` либо доустановить flashinfer.
- **Симптом:** `ValueError: Unknown Mamba SSU backend: 'flash_infer'. Valid options are: TRITON, FLASHINFER, CPU`. **Причина:** опечатка. **Лечение:** `flashinfer`.
- **Симптом:** флаг задан, а в логе нет строки `Using ... Mamba SSU backend.` **Причина:** в модели нет групп `MAMBA1`/`MAMBA2` — инициализация backend'а пропущена. **Проверка:** состав групп KV-cache в стартовом логе.
- **Симптом:** `RuntimeError: Mamba SSU backend has not been initialized.` **Причина:** внутренняя ошибка порядка инициализации, а не следствие значения флага.
- **Симптом:** на CPU-инстансе в логе `CPU platform detected: overriding Mamba SSU backend from 'triton' to 'cpu'.` **Причина:** штатная подмена. Задавать `--mamba-backend cpu` вручную для этого не нужно.
- **Подтверждение принятого значения:** `Using triton Mamba SSU backend.` / `Using flashinfer Mamba SSU backend.` / `Using cpu Mamba SSU backend.`, а для FlashInfer дополнительно `Using FlashInfer Mamba SSU algorithm: auto`.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --mamba-backend flashinfer --max-model-len 32768
```

```bash
vllm serve /models/Nemotron-H-8B --mamba-backend triton --mamba-cache-mode align --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/mamba.py`
- `vllm/vllm/model_executor/layers/mamba/ops/ssu_dispatch.py`
- `vllm/vllm/model_executor/layers/mamba/ops/mamba_ssm.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_mixer2.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
