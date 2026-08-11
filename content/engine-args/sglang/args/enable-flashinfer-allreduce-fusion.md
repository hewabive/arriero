---
schema: 1
engine: sglang
primaryName: "--enable-flashinfer-allreduce-fusion"
title: "--enable-flashinfer-allreduce-fusion"
summary: Устаревший включатель слияния allreduce с Residual+RMSNorm через FlashInfer. Заменен на `--flashinfer-allreduce-fusion-backend`, где вместо булева «включить» выбирается конкретный backend (`auto`, `trtllm`, `mnnvl`).
group: null
related:
  - --flashinfer-allreduce-fusion-backend
  - --enforce-disable-flashinfer-allreduce-fusion
  - --enable-aiter-allreduce-fusion
  - --tp-size
  - --enable-dp-attention
  - --moe-a2a-backend
  - --enable-deterministic-inference
  - --enable-prefill-cp
---

# --enable-flashinfer-allreduce-fusion

## Кратко

При тензорном параллелизме после каждого блока внимания и MLP выполняется allreduce, а следом — сложение с residual и RMSNorm. FlashInfer умеет слить эти три операции в одно ядро, что убирает лишние проходы по памяти. Раньше это включалось булевым флагом; теперь backend слияния выбирается явно через `--flashinfer-allreduce-fusion-backend` (`auto`, `trtllm`, `mnnvl`), потому что доступность зависит от поколения карт и от топологии узлов.

Флаг устарел «мягко»: он объявлен обычным `store_true`, а не через семейство `Deprecated*Action`, поэтому предупреждение печатает не argparse, а `_handle_deprecated_args` — и только если новый аргумент не задан.

## Оригинальная справка

```text
(Deprecated: use --flashinfer-allreduce-fusion-backend=auto) Enable FlashInfer allreduce fusion with Residual RMSNorm.
```

## Паспорт аргумента

- Флаги: `--enable-flashinfer-allreduce-fusion`
- Группа: `null` — флаг объявлен литеральным `parser.add_argument` в `add_cli_args`; одноименное поле датакласса помечено `Arg(no_cli=True)` и собственного CLI не имеет
- Тип значения: флаг без значения (`action="store_true"`)
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `False`
- Эффективное значение: `_handle_deprecated_args` при `True` и незаданном `flashinfer_allreduce_fusion_backend` печатает предупреждение и ставит `flashinfer_allreduce_fusion_backend = "auto"`. После этого поле `enable_flashinfer_allreduce_fusion` **безусловно** сбрасывается в `False` — независимо от того, был флаг задан или нет
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: устаревший, но реализован обычным `store_true`; замена — `--flashinfer-allreduce-fusion-backend auto`
- Этап применения: разбор CLI → `__post_init__` → `_handle_deprecated_args` → пассы резолюции в `arg_groups/overrides.py` → инициализация коммуникатора

## Что меняет в движке

### Предупреждение и трансляция

```python
if self.enable_flashinfer_allreduce_fusion and self.flashinfer_allreduce_fusion_backend is None:
    logger.warning(
        "--enable-flashinfer-allreduce-fusion is deprecated. "
        "Please use --flashinfer-allreduce-fusion-backend=auto instead."
    )
    self.flashinfer_allreduce_fusion_backend = "auto"
self.enable_flashinfer_allreduce_fusion = False
```

Обратите внимание на два отличия от прочих устаревших флагов SGLang: предупреждение печатается на этапе `__post_init__` (то есть уже с обычным форматом лога и временным префиксом, а не в начале вывода), и оно не появится вовсе, если новый аргумент задан явно — тогда старый флаг просто молча проигнорируется.

### Что делает backend слияния

Значение `auto` разрешается позже, в пассе `_flashinfer_allreduce_fusion_auto_enable`: `mnnvl` на Blackwell (SM100/SM103, одно- и многоузловые системы), `trtllm` на SM90 в одноузловой конфигурации. Тот же пасс включает слияние **самостоятельно**, без всяких флагов, если совпал набор условий: архитектура модели из списка поддерживаемых, SM90 или SM10x, `tp_size > 1`, выключенный DP attention, одноузловая конфигурация (или SM100+), и `moe_a2a_backend == "none"`. В логе это видно как:

```text
Auto-enabling FlashInfer AllReduce Fusion on SM90/SM10X for <архитектура>
```

Дальше два пасса могут снять слияние обратно: `--enforce-disable-flashinfer-allreduce-fusion` (`FlashInfer allreduce fusion is forcibly disabled via --enforce-disable-flashinfer-allreduce-fusion.`) и детерминированный вывод (`Disable --flashinfer-allreduce-fusion-backend because deterministic inference is enabled.`).

## Значения и формат

- Булев флаг без значения.
- Работает только как «включить с backend'ом `auto`». Выбрать `trtllm` или `mnnvl` им нельзя — для этого нужен новый аргумент.
- Задать его вместе с `--flashinfer-allreduce-fusion-backend` можно, но старый флаг в этом случае не делает ничего и даже не предупреждает.
- Требует SM90 или SM10x — это ограничение самого механизма, а не аргумента.
- В YAML через `--config` ключ `enable-flashinfer-allreduce-fusion` задается нормально: это `store_true`, а не Deprecated-действие. А вот `flashinfer-allreduce-fusion-backend` в YAML работает, потому что на его `dest` устаревших алиасов нет.

## Когда использовать

- Не использовать: пишите `--flashinfer-allreduce-fusion-backend auto`.
- Чаще всего ничего писать вообще не нужно: авто-включение само срабатывает на подходящих конфигурациях.
- Явный backend нужен там, где авто-условия не выполняются (например, при `--enable-dp-attention` или ненулевом a2a-backend'е), а вы точно знаете, что связка рабочая.
- Не сочетать с `--enable-deterministic-inference`: слияние будет снято резолюцией.
- Несовместимо с context parallelism в части aiter-варианта: `--enable-aiter-allreduce-fusion` при CP отвергается утверждением.

## Влияние на производительность и память

- Пропускная способность: слияние убирает лишние проходы по памяти между allreduce, residual и RMSNorm; выигрыш заметен на моделях с большим hidden size и `tp_size > 1`.
- VRAM: дополнительной статики не требует, но FlashInfer выделяет собственные рабочие буферы под слитое ядро.
- Время старта: JIT-компиляция ядер FlashInfer при первом использовании (кешируется).
- Latency: главный выигрыш на decode, где число коллективов на токен фиксировано.

## Взаимодействие с другими аргументами

- `--flashinfer-allreduce-fusion-backend`: актуальная замена; `auto`, `trtllm`, `mnnvl`.
- `--enforce-disable-flashinfer-allreduce-fusion`: жестко снимает слияние поверх любых авто-включений.
- `--enable-aiter-allreduce-fusion`: аналог для ROCm; несовместим с context parallelism.
- `--tp-size`: слияние имеет смысл только при значении больше 1.
- `--enable-dp-attention`, `--moe-a2a-backend`: их включение блокирует авто-выбор слияния.
- `--enable-deterministic-inference`: снимает слияние.

## Типовые проблемы и диагностика

- `--enable-flashinfer-allreduce-fusion is deprecated. Please use --flashinfer-allreduce-fusion-backend=auto instead.` — замените флаг.
- Флаг задан, а слияния нет — либо рядом задан новый аргумент (тогда старый молча игнорируется), либо слияние снято `--enforce-disable-…` или детерминированным выводом, либо конфигурация не проходит по железу.
- Слияние включилось само, хотя ничего не задавали, — сработал `_flashinfer_allreduce_fusion_auto_enable`; ищите строку `Auto-enabling FlashInfer AllReduce Fusion …`.
- Ошибки FlashInfer при инициализации коммуникатора — backend недоступен для вашего поколения карт; поставьте `--enforce-disable-flashinfer-allreduce-fusion`.
- Что смотреть: `flashinfer_allreduce_fusion_backend=` в дампе `server_args=` (значение `enable_flashinfer_allreduce_fusion` всегда `False` и ни о чем не говорит).

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-70B-Instruct --tp-size 4 --flashinfer-allreduce-fusion-backend auto
```

Явный backend и принудительное отключение на соседнем сервере:

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-70B-Instruct --tp-size 4 --flashinfer-allreduce-fusion-backend trtllm
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/flashinfer_comm_fusion.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
