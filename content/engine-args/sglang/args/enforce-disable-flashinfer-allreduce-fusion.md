---
schema: 1
engine: sglang
primaryName: "--enforce-disable-flashinfer-allreduce-fusion"
title: "--enforce-disable-flashinfer-allreduce-fusion"
summary: Единственный способ отменить автоматическое включение FlashInfer-фьюжена all-reduce для MoE-архитектур из встроенного списка. Выполняется сразу после авто-включения и всегда побеждает его.
group: exec.comm
related:
  - --flashinfer-allreduce-fusion-backend
  - --enable-deterministic-inference
  - --enable-aiter-allreduce-fusion
  - --tp-size
  - --enable-dp-attention
  - --moe-a2a-backend
---

# --enforce-disable-flashinfer-allreduce-fusion

## Кратко

Для полутора десятка MoE-архитектур на SM90/SM100 SGLang сам подставляет `--flashinfer-allreduce-fusion-backend auto`, если оператор ничего не задал. Обычно это то, что нужно, но не всегда: слитое ядро меняет порядок арифметики, изредка конфликтует с конкретной сборкой FlashInfer и мешает A/B-сравнению. Отменить авто-включение «пустым значением» нельзя — argparse не примет пустую строку в списке `auto|trtllm|mnnvl`. Для этого и существует отдельный булев флаг: он выполняется следующим проходом после авто-включения и записывает `flashinfer_allreduce_fusion_backend = None`.

## Оригинальная справка

```text
Enforce disable FlashInfer allreduce fusion.
```

## Паспорт аргумента

- Флаги: `--enforce-disable-flashinfer-allreduce-fusion`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: поднимается в `True` автоматически при `--enable-deterministic-inference` — это первая строка `_handle_model_specific_adjustments` (`sglang/python/sglang/srt/server_args.py`). То есть детерминированный режим отменяет фьюжен двумя независимыми путями: через этот флаг и через отдельный проход `_deterministic_allreduce_fusion_disable`
- Где объявлен: `ServerArgs.enforce_disable_flashinfer_allreduce_fusion`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__`: `_handle_model_specific_adjustments` (взведение в детерминированном режиме) → проход `_enforce_disable_allreduce_fusion` реестра `arg_groups/overrides.py`, сразу после `_flashinfer_allreduce_fusion_auto_enable`

## Что меняет в движке

Весь код флага — один проход реестра переопределений:

```python
@register_post_process
def _enforce_disable_allreduce_fusion(view: Any) -> dict:
    if view.enforce_disable_flashinfer_allreduce_fusion:
        logger.info("FlashInfer allreduce fusion is forcibly disabled "
                    "via --enforce-disable-flashinfer-allreduce-fusion.")
        return {"flashinfer_allreduce_fusion_backend": None}
    return {}
```

Комментарий у прохода фиксирует контракт: «the user's enforce-disable switch wins over every model-specific adjustment». Порядок важен — проход стоит **после** авто-включения, поэтому перекрывает и его, и явно заданное значение `--flashinfer-allreduce-fusion-backend`.

Дальше `None` в этом поле выключает всё сразу: `apply_flashinfer_allreduce_fusion` возвращает `False` на каждом вызове, `resolve_flashinfer_allreduce_fusion_backend` возвращает `None`, а `_pre_initialize_flashinfer_allreduce_workspace` выходит без выделения буферов. То есть флаг экономит еще и VRAM под workspace.

Что при этом происходит с редукцией: слои возвращаются к обычной последовательности «all-reduce → residual → RMSNorm», где all-reduce проходит стандартную цепочку выбора (`ca → qr → pymscclpp → torch_symm_mem → pynccl`). Никакой особой топологии флагу не нужно — он ничего не включает, только выключает.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Задавать вместе с `--flashinfer-allreduce-fusion-backend` не запрещено, но бессмысленно: enforce-disable выигрывает, и явное значение будет просто проигнорировано.
- На ROCm-фьюжен (`--enable-aiter-allreduce-fusion`) флаг не действует — это другой механизм и другое поле.
- Вне SM90/SM100 флаг тоже безвреден: фьюжен там и так не включается.

## Когда использовать

- Модель из списка авто-включения (DeepSeek-V3/V3.2, GPT-OSS, GLM-4 MoE и MoE-Lite, GLM DSA, Mistral Large 3, Qwen3-MoE и Qwen3-VL-MoE, Qwen3-Next, Qwen3.5 и Qwen3.5-MoE, InternS2 Preview, Kimi-K2.5, NemotronH и NemotronH-Puzzle), и вы подозреваете фьюжен в расхождении результатов или в падении.
- Разбор инцидента: снять фьюжен, получить «чистый» базовый профиль, сравнить.
- Ситуация, где нужно освободить VRAM под workspace фьюжена (сотни МиБ на ранг на моделях с большим `hidden_size`) и вы согласны на потерю latency.
- Не задавайте его вместе с `--enable-deterministic-inference` — детерминированный режим ставит флаг сам.
- Не используйте его как «общий выключатель слияния all-reduce»: aiter-путь на ROCm он не трогает.

## Влияние на производительность и память

- **Latency.** Ухудшается на тех архитектурах, где фьюжен работал: возвращаются три ядра вместо одного на хвосте каждого блока. Эффект заметен на decode с батчем до 2048 токенов — именно там фьюжен и применялся.
- **VRAM.** Освобождается workspace FlashInfer (размер ≈ `2048 × hidden_size × itemsize` с запасом, на ранг). Это единственный положительный эффект флага по памяти.
- **Время старта.** Немного уменьшается: не выполняются инициализация workspace и rendezvous по группе.
- **Точность.** Возвращается к арифметике обычного пути; ради этого флаг чаще всего и включают.
- **Throughput.** На длинных prefill-чанках не меняется — там фьюжен и так не срабатывал.

## Взаимодействие с другими аргументами

- `--flashinfer-allreduce-fusion-backend`: перекрывается этим флагом безусловно, включая явно заданные `trtllm` и `mnnvl`.
- `--enable-deterministic-inference`: сам взводит этот флаг.
- `--enable-aiter-allreduce-fusion`: независим; чтобы снять ROCm-фьюжен, выключайте его собственный флаг.
- `--enable-dp-attention`, `--moe-a2a-backend`, `--tp-size`: влияют на условия авто-включения; если авто-включение и так не сработало, этот флаг ничего не меняет.

## Типовые проблемы и диагностика

- **Симптом:** задан `--flashinfer-allreduce-fusion-backend mnnvl`, а фьюжен не работает. **Причина:** в той же строке запуска есть enforce-disable. **Проверка:** строка `FlashInfer allreduce fusion is forcibly disabled via --enforce-disable-flashinfer-allreduce-fusion.` в логе старта.
- **Симптом:** флаг задан, но `server_args=` показывает `enforce_disable_flashinfer_allreduce_fusion=True` при выключенном детерминизме — и вы его не задавали. **Причина:** `--rl-on-policy-target` включает детерминированный режим, а он взводит этот флаг.
- **Симптом:** после включения флага decode стал медленнее. **Причина:** это ожидаемая цена; фьюжен действительно работал.
- **Что смотреть:** `Auto-enabling FlashInfer AllReduce Fusion …` (было ли авто-включение), затем `FlashInfer allreduce fusion is forcibly disabled …` (сняли ли его), и итоговое `flashinfer_allreduce_fusion_backend=None` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --tensor-parallel-size 8 --enforce-disable-flashinfer-allreduce-fusion
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --enforce-disable-flashinfer-allreduce-fusion --disable-custom-all-reduce
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/flashinfer_comm_fusion.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
